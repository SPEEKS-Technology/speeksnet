-- ============================================================================
-- PICTURE GUIDE — categories collect into groups.
--
-- "Group these items into categories, like Smart Watches, rather than having
-- Apple and android being 2 individual line items" (user, 2026-09-07). With
-- 10-15 sheets after condensing, a flat rail is a wall of near-identical names
-- where the differences that matter (Apple vs Android) sit at the END of the
-- label, which is the worst place to scan for them.
--
-- WHY A TEXT COLUMN AND NOT A pg_groups TABLE.
-- A groups table would buy a rename-in-one-place and an explicit group order.
-- It would also add a second ordering system, orphan rows to clean up when the
-- last category leaves a group, and a second thing for the DM to maintain. The
-- column avoids all of it:
--
--   * A group EXISTS because a category names it, and stops existing when the
--     last one stops. There is no such thing as an empty group to tidy up.
--   * Group ORDER is the sort_order of the first category in it, so the DM keeps
--     dragging categories and the groups fall out. One ordering, not two.
--   * Renaming a group means editing the categories in it. That is the one real
--     cost, and with a handful of sheets per group it is a handful of edits —
--     paid rarely, against a saving paid on every screen.
--
-- NULL = ungrouped, and an ungrouped category renders at the top level of the
-- rail rather than under an "Other" heading it never asked to be in.
-- ============================================================================

alter table public.pg_categories add column if not exists group_name text;

-- The three seeded sheets, grouped the way the rail is meant to read. These are
-- starting points, not fixtures — the DM renames or regroups them in the editor
-- and nothing here has to change.
update public.pg_categories set group_name = 'Smart Tablets'
 where slug = 'android-tablets' and group_name is null;
update public.pg_categories set group_name = 'Smart Watches'
 where slug = 'apple-watches'   and group_name is null;
update public.pg_categories set group_name = 'Computer Parts'
 where slug = 'processors'      and group_name is null;
