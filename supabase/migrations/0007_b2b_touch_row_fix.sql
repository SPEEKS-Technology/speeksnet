-- ============================================================================
-- Fix: every UPDATE on b2b_clients failed with
--   record "new" has no field "stage"
--
-- b2b_touch_row() is shared by the b2b_deals and b2b_clients touch triggers, and
-- guarded the stage check with:
--
--   if tg_table_name = 'b2b_deals' and new.stage is distinct from old.stage
--
-- which reads as safe but is not. PL/pgSQL hands the whole condition to the SQL
-- executor as one expression, so NEW.stage has to resolve against the actual row
-- type before the table-name test can rule it out -- and on a b2b_clients row
-- there is no such field. `and` is not a short circuit here.
--
-- Nesting the tests means the field is only ever named inside the branch that
-- runs for the table that has it.
--
-- Introduced by 0002 (which added the b2b_clients trigger) and missed because
-- the live tests around it exercised client INSERTs, not UPDATEs. Caught by the
-- outreach work, which is the first thing to update a client row on the server.
-- Left in place in 0002 rather than edited: the migration history should record
-- what actually ran.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

create or replace function public.b2b_touch_row()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_table_name = 'b2b_deals' then
    if new.stage is distinct from old.stage then
      new.stage_changed_at := now();
    end if;
  end if;
  return new;
end;
$$;
