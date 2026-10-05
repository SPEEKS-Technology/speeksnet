-- 0092 — one listing_goals row per store, per day, per person
--
-- WHY
-- There was nothing stopping duplicates, and there were duplicates.
--
-- The listing-goals edge function saves a day by DELETING every row for
-- (store, date) and then INSERTing the roster fresh. Two of those in flight at
-- once — a manager's debounced autosave landing while a second client saves, or
-- one double-tap — interleave as delete, delete, insert, insert, and the day
-- ends up with two complete copies of itself. That is exactly the shape found
-- in the live data: on 2026-09-09 every one of OVL's six people had precisely
-- two rows.
--
-- It went unnoticed because the WIDGET dedupes on the way in ("last row in the
-- sheet wins per day", renderGoalsScoreboard) while the SERVER does not:
-- breakdown() sums every row it finds into `adjusted`, which is the
-- `Staffed For` column and the denominator of the efficiency ratio. So the
-- store saw the right daily numbers and the DM saw a denominator inflated by a
-- whole duplicated day — 47 listings of the 349 OVL was measured against for
-- the week of 2026-09-07, dragging it from 49% to the 42% on the board.
--
-- Two managers looking at the same week and disagreeing is the bug this is half
-- of; the other half is that the two screens measure different things, which is
-- a rendering change, not a schema one.
--
-- The index is the real fix — the edge function is moved to an upsert in the
-- same change, but an upsert with no constraint to conflict on is just an
-- insert, so the constraint has to exist first.

-- Collapse what is already there. The HIGHEST id wins: rows are inserted in
-- roster order within one save, so the last complete write is the newest block
-- of ids, and that is the save a manager would expect to have stuck.
DELETE FROM listing_goals a
 USING listing_goals b
 WHERE a.store = b.store
   AND a.date = b.date
   AND a.employee = b.employee
   AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS listing_goals_store_date_employee_key
    ON listing_goals (store, date, employee);

COMMENT ON INDEX listing_goals_store_date_employee_key IS
  'One role per person per day. Added in 0092 after a concurrent delete-then-insert left whole days duplicated, which silently doubled the Staffed For denominator on the DM efficiency table.';
