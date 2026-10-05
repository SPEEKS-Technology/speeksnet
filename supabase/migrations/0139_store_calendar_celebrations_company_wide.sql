-- ============================================================================
-- The imported birthdays and work anniversaries become company-wide.
-- APPLIED 2026-10-05 through the Supabase MCP (apply_migration).
--
-- WHY. The 0126 import filed each person's birthday and anniversary on their
-- own store (a store event), which was a guess. Ethan, 2026-10-05: "The
-- anniversaries and I guess maybe bdays are still showing for just the store.
-- This should be company wide" — the same call as earlier that day, "keep
-- birthdays and anniversaries viewed by everyone if put in by company. We want
-- to encourage comraderie". These came from his calendar, so they are company
-- events: posted to all five stores, read-only to the stores, his to edit.
--
-- Touches only source = 'google' celebration rows: 11 store events become
-- company events, and the one company birthday posted to MPL+BAL (Joseph
-- Ortega's) is widened to all five so its "All stores" tag tells the truth.
-- A birthday a store adds for itself later stays that store's.
-- ============================================================================

update public.store_calendar_events
   set scope = 'company', store = null,
       stores = array['OVL', 'LEE', 'WSP', 'MPL', 'BAL'],
       updated_at = now()
 where source = 'google' and category = 'celebration';
