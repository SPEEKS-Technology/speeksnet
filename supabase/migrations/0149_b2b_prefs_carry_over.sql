-- ============================================================================
-- Carry each person's B2B email choice across the category split (0148).
--
-- Until 0148, B2B alerts were a sub-switch inside "Requests Waiting On Me", so
-- anyone who had switched Requests OFF was not getting B2B mail. cat_b2b was
-- added defaulting to true, which on its own would have started mailing B2B to
-- exactly those people the day b2b-deals began queueing under `b2b`. Copying
-- cat_requests across keeps everybody receiving what they received before; the
-- two switches are independent from here on.
--
-- Applied via Supabase MCP `apply_migration` on 2026-10-16. NUMBERING: first written
-- as 0141/0142 off pre-release, whose highest file was 0140 -- but Ethan's
-- unmerged Main-November-Update-2 branch had already applied 0141-0147. Renamed
-- here to follow it; the database's migration history still records this one
-- under its original 014x name.
-- ============================================================================

update public.user_notify_prefs
   set cat_b2b = cat_requests
 where cat_b2b is distinct from cat_requests;
