-- ============================================================================
-- Let the pricing sheet be reordered, and have the quote follow it.
--
-- line_no cannot double as the ordering. It is baked into every SKU
-- (ACM-001-0004) and those SKUs are printed on labels that are already stuck to
-- physical units -- renumbering lines to reorder them would silently repoint
-- barcodes at different kit. So the display order gets its own column and
-- line_no keeps meaning "which line this has always been".
--
-- Spaced by ten, the same convention box_order_items uses: it leaves room to
-- drop a row between two others without rewriting the whole set, though the
-- reorder action rewrites them all anyway for simplicity.
--
-- Ordering is (sort_order, line_no) everywhere, never sort_order alone. Two rows
-- can legitimately share a value -- a row added after this migration starts at
-- 0 until someone drags something -- and without the tiebreak the grid would
-- shuffle between reads for no reason the user could see.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

alter table public.b2b_deal_items
  add column if not exists sort_order int not null default 0;

-- Seed from the order lines were created in, so nothing appears to move on the
-- day this ships.
update public.b2b_deal_items
   set sort_order = line_no * 10
 where sort_order = 0;

create index if not exists b2b_deal_items_order_idx
  on public.b2b_deal_items (deal_id, sort_order, line_no);
