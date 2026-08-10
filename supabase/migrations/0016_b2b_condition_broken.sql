-- ============================================================================
-- Rename the 'For Parts' condition to 'Broken'.
--
-- Same meaning, plainer word -- asked for in the feedback round as "MAKE FOR
-- PARTS JUST BROKEN". Behaviour is unchanged: a Broken line still has to carry a
-- client-facing reason before the deal can be quoted, and can still be any
-- disposition.
--
-- condition is free text with only a length CHECK (b2b_deal_items_text_len,
-- <= 40 chars), so there is no constraint to widen -- just the stored values.
--
-- At the time of writing this matched no rows: b2b_deal_items held 7 'Fair' and
-- 8 NULL. It is here so the same statement runs against any environment that
-- does have them, and so the rename is recorded rather than existing only as a
-- string changed in two source files.
--
-- The old spelling stays RECOGNISED in code on both sides -- B2B_REASON_CONDITIONS
-- in speeks.js and REASON_CONDITIONS in the b2b-deals function -- because a row
-- written in the window between that deploying and this running would otherwise
-- stop being asked for a reason, and would stop silently. Removing those two
-- legacy entries is safe only once no row can predate this migration.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

update public.b2b_deal_items
   set condition = 'Broken'
 where condition = 'For Parts';
