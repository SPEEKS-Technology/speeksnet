-- Every other table in this project has RLS ON with no policies: nothing reaches
-- the tables through the public anon key, and every read and write goes through
-- an edge function holding the service role (which bypasses RLS). patch_note_read_log
-- was created without it, so the anon key shipped in speeks.js could read the whole
-- read log and insert rows into it.
--
-- No policy is added, deliberately -- that is what the other 100+ tables do, and
-- patch-notes reads and writes this table with SUPABASE_SERVICE_ROLE_KEY.
alter table patch_note_read_log enable row level security;
