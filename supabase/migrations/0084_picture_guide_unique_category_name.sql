-- Picture Guide: one category per name.
--
-- Two sheets called the same thing are indistinguishable in the rail, and the
-- rail is the only way to reach a sheet. A DM who made "Graphics Cards" twice
-- would have no way to tell which one holds the photos they uploaded, and no
-- way to tell which one every store is reading.
--
-- The dialog checks this too, but a check in the browser is a courtesy, not a
-- guarantee: two DMs creating the same category in the same minute both pass it,
-- and a POST straight at the edge function skips it entirely. The index is the
-- part that cannot be talked out of it.
--
-- lower(name), because "Graphics Cards" and "graphics cards" are the same sheet
-- to everyone reading the rail.
--
-- WHERE ACTIVE is the whole reason this is a partial index. deleteCategory is a
-- soft delete: the row stays with active = false so a category removed by
-- mistake comes back whole, with its photos. Three soft-deleted rows named
-- "Test" already exist from testing this tool, and a plain unique index would
-- refuse to be created at all. It would also mean a name could never be reused
-- after a category was removed, which is the opposite of the point.
--
-- Trailing whitespace is NOT normalised here. "Graphics Cards " would slip past
-- this index, but every write path trims before it inserts, so a name with a
-- trailing space cannot be stored in the first place.

create unique index if not exists pg_categories_active_name_unique
    on public.pg_categories (lower(name))
    where active;
