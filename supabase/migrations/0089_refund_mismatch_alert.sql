-- ============================================================================
-- refund-mismatch — an order reversed on ONE marketplace and not the other.
--
-- THE PROBLEM THIS REPLACES. Every month the CFO mails a list of order numbers
-- that were refunded or cancelled on eBay but not Shopify, or the reverse. Each
-- one is a hole in the books: one system says we kept the money and the other
-- says we gave it back. By the time the list arrives the period is closed and
-- the correction is an adjusting entry rather than a fix.
--
-- ⚠️ THIS FEATURE NEVER ISSUES A REFUND. It reads both marketplaces and mails a
-- manager. The refund is pushed by a person, on both sites, by hand. That is a
-- deliberate constraint set by the business on 2026-09-16, not an implementation
-- gap — see the enforcement notes at the head of the edge function. `refund-apply`
-- is the function that CAN write refunds; nothing here calls it or shares a path
-- with it.
--
-- WHY A STATE TABLE AND NOT A QUERY. The alert has to know what it has already
-- said, or a three-day-old mismatch is re-mailed every morning until somebody
-- gives up and filters the sender. Same shape as `ebay_alert_state`: a stable
-- issue_key describing the PROBLEM (never the time it was noticed), so the same
-- mismatch recognises itself on the next pass.
--
-- WHY ROWS ARE RESOLVED RATHER THAN DELETED. ebay_alert_state deletes a row when
-- the fault stops being detected, because there the history is worthless. Here it
-- is the whole point: "how many did we catch, and how fast" is the number that
-- proves this replaced the CFO's list. Resolved rows stay, and `open` means
-- resolved_at is null.
--
-- DISCOVERY IS WINDOWED; TRACKING IS NOT. The function only looks back
-- WINDOW_DAYS for NEW mismatches, but once a row exists here it is re-checked
-- every run regardless of age. Otherwise a mismatch nobody fixed would silently
-- fall out of the window and stop being chased at exactly the point it had
-- become most serious.
-- ============================================================================

create table if not exists public.refund_mismatch_state (
  issue_key           text primary key,
  store_code          text        not null,
  ebay_order_id       text        not null,
  -- 'ebay_only'    reversed on eBay, still a live sale in Shopify
  -- 'shopify_only' reversed in Shopify, still a live sale on eBay
  direction           text        not null
    check (direction in ('ebay_only', 'shopify_only')),

  shopify_order_name  text,
  shopify_order_id    text,

  -- WHEN THE REVERSAL HAPPENED ON THE SIDE THAT HAS ONE -- not when we noticed.
  -- The age that decides whether to alert is measured from this, so the very
  -- first run after deploy correctly reports a mismatch that is already a week
  -- old instead of treating it as new.
  reversed_at         timestamptz not null,
  reversal_kind       text,                 -- 'refund' | 'cancel'
  amount              numeric,

  first_seen          timestamptz not null default now(),
  last_seen           timestamptz not null default now(),
  last_alerted        timestamptz,
  times_alerted       integer     not null default 0,
  -- Set once, when the item passes the escalation age and leadership is copied.
  -- Nullable rather than a boolean so the date itself is the evidence.
  escalated_at        timestamptz,
  resolved_at         timestamptz
);

comment on table public.refund_mismatch_state is
  'Open and historical cross-marketplace refund mismatches. Written only by the '
  'refund-mismatch edge function, which is read-only against eBay and Shopify.';

-- The two reads the function actually makes: "every open row" on each pass, and
-- "this store''s open rows" when building one manager''s mail.
create index if not exists refund_mismatch_state_open_idx
  on public.refund_mismatch_state (store_code, reversed_at)
  where resolved_at is null;

-- Service-role only, matching ebay_alert_state / refund_apply_log: RLS on with
-- no policy, so nothing reaches it with an anon or authenticated key. The site
-- does not read this table -- the alert is email-only in this pass.
alter table public.refund_mismatch_state enable row level security;

-- ----------------------------------------------------------------------------
-- WHO GETS MAILED.
--
-- One list per store rather than a single list, because a mismatch is a job for
-- the manager of the store that owns the order and nobody else. Five stores,
-- four managers -- BAL and MPL share one, exactly as MULTISTORE_MANAGER_STORES
-- in speeks.js says -- so the function groups by recipient and sends one mail
-- per person covering their store(s), never two mails to the same inbox.
--
-- Seeded BY SELECT from the weekly_store_* lists rather than with literal
-- addresses: those lists already hold "the manager of this store", and copying
-- them keeps personal email addresses out of the repository. The keys are also
-- added to LIST_KEYS in the email-recipients function, so the DM can edit them
-- from the Email Recipients tool. A list that is only ever inserted here becomes
-- an orphan nobody can change without SQL -- the mistake sales_import_alert made.
-- ----------------------------------------------------------------------------
insert into public.email_recipients (list_key, email)
select 'refund_mismatch_' || right(r.list_key, 3), r.email
from public.email_recipients r
where r.list_key like 'weekly_store_%'
on conflict do nothing;

-- Leadership copy, used only once an item passes the escalation age. Separate
-- list so raising the escalation threshold never silently changes who is on it.
insert into public.email_recipients (list_key, email)
select 'refund_mismatch_escalation', r.email
from public.email_recipients r
where r.list_key = 'weekly_leadership'
on conflict do nothing;

-- ============================================================================
-- SCHEDULE -- applied via Supabase MCP `execute_sql`, because cron.schedule is a
-- function call rather than DDL. Recorded here for provenance, same convention
-- as 0008_b2b_outreach_cron.sql.
--
-- Two UTC schedules, each gated on the local hour, so exactly one fires per day
-- through both halves of the year.
--
-- ⚠️ 8:20am CENTRAL, AND THE TWENTY MINUTES MATTER. The morning sales import runs
-- at :00 and Net Profit at :05, and both share one Apps Script lock with the
-- Gmail relay this function mails through. Landing on either would queue behind
-- a job that can run for minutes. 8:20 is clear of both and still lands before a
-- manager has started the day.
--
-- Daily, not every 15 minutes like ebay-alert: the thing being watched is three
-- days old by the time it qualifies, so a faster cadence would buy nothing and
-- spend eBay API calls hourly for it.
--
--   select cron.schedule('refund-mismatch-daily-cdt', '20 13 * * *', $job$
--     select net.http_post(
--       url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/refund-mismatch?secret=sp33ks-sync-k3y-2026-x9mq&store=ALL',
--       headers := '{"Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb,
--       timeout_milliseconds := 300000
--     ) where extract(hour from (now() at time zone 'America/Chicago')) = 8;
--   $job$);
--
--   select cron.schedule('refund-mismatch-daily-cst', '20 14 * * *', $job$
--     select net.http_post(
--       url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/refund-mismatch?secret=sp33ks-sync-k3y-2026-x9mq&store=ALL',
--       headers := '{"Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb,
--       timeout_milliseconds := 300000
--     ) where extract(hour from (now() at time zone 'America/Chicago')) = 8;
--   $job$);
-- ============================================================================
