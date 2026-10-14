-- ============================================================================
-- Remember which line a split line came from, so a split can be undone.
--
-- split_item (b2b-deals) divides one line into two ordinary lines so part of it
-- can go to another store. Without a record of where the new line came from,
-- a split made by mistake could never be put back: two lines with the same
-- make and model are not necessarily one line cut in half, and guessing would
-- merge lines the client quoted separately.
--
-- Nullable, and null for every line that was not split off another. ON DELETE
-- SET NULL rather than CASCADE: deleting a parent line must never take the
-- units split off it with it -- they are real stock at another store.
-- ============================================================================

alter table public.b2b_deal_items
  add column if not exists split_from uuid
    references public.b2b_deal_items(id) on delete set null;

create index if not exists b2b_deal_items_split_from_idx
  on public.b2b_deal_items (split_from) where split_from is not null;
