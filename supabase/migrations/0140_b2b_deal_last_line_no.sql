-- ============================================================================
-- Remember the highest line number a deal has ever handed out.
--
-- split_item (b2b-deals) gives a split line the next line number and the SKU
-- built from it. "Next" was max(line_no) + 1 over the lines still on the deal,
-- and merge_item deletes the split line when it folds back. So: split off
-- 0005, merge 0005 back, split again -- and the new line was 0005 again, with
-- the same SKU. A label printed for the first 0005 then scanned to a different
-- line. Found by the live split-deal test on 2026-10-05.
--
-- A high-water mark on the deal fixes it without renumbering anything: the
-- function takes greatest(max line on the deal, last_line_no) + 1 and writes
-- the new number back. Backfilled to each deal's current highest line, so the
-- first split after this behaves exactly as before.
--
-- Pricing (add_item / delete_item) still uses max + 1 and does not touch this:
-- lines are only split after acceptance, when no more can be added.
-- ============================================================================

alter table public.b2b_deals
  add column if not exists last_line_no integer not null default 0;

update public.b2b_deals d
   set last_line_no = m.max_line
  from (select deal_id, max(line_no) as max_line
          from public.b2b_deal_items group by deal_id) m
 where m.deal_id = d.id
   and d.last_line_no < m.max_line;
