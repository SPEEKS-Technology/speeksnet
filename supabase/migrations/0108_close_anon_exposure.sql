-- 0108 — close the three places anon could still reach the database
--
-- Supabase's security advisor emailed on 2026-09-19: "Table publicly
-- accessible — anyone with your project URL can read, edit, and delete all
-- data in this table." It was right, and the project URL and anon key are
-- both sitting in speeks.js where anyone can read them.
--
-- THE CONVENTION THIS RESTORES
-- anon and authenticated hold full SELECT/INSERT/UPDATE/DELETE grants on
-- every table in public — that is Supabase's default and we have never
-- revoked it. So RLS is the ONLY thing standing between the anon key and the
-- whole schema. The house pattern, stated in 0102, is "RLS on, no policy":
-- deny everyone, and let the edge functions through on the service role,
-- which bypasses RLS. 138 tables are set up that way. These three were not.
--
--   listing_week_capacity (0093) — the frozen roster snapshot. Names, roles,
--     contracted hours and shifts for every employee, per store, per week.
--     Staff PII, readable and deletable by anyone who opened dev tools.
--
--   hold_replies (0107, yesterday) — the "I answered eBay" receipt. Writable
--     by anyone, which means the status gate the whole migration exists to
--     enforce could be unlocked from outside the app.
--
--   listing_title_queue (0067, rewritten in 0070 and 0079) — a view, so it
--     has no RLS of its own. Without security_invoker it runs as its OWNER,
--     and the owner's rights bypass the RLS on the tables underneath. It was
--     a working window onto ebay_listings and listing_title_reviews for
--     anyone with the anon key, regardless of how those tables are locked.
--
-- WHY THIS BREAKS NOTHING
-- Checked every reader before writing this. listing_week_capacity is touched
-- only by store-targets, hold_replies only by claims-disputes, and
-- listing_title_queue only by listing-titles and shopify-recat. All four
-- functions read SUPABASE_SERVICE_ROLE_KEY and none of them mention the anon
-- key. Service role bypasses RLS and ignores security_invoker, so every
-- current caller sees exactly what it saw yesterday. What changes is that
-- the anon key now sees nothing.

-- Deny-all, service-role-only — same as every other table here.
alter table public.listing_week_capacity enable row level security;
alter table public.hold_replies          enable row level security;

-- Make the view answer with the CALLER's rights, so the RLS on the base
-- tables actually applies to it. Postgres 15+; we are on 17.
alter view public.listing_title_queue set (security_invoker = on);
