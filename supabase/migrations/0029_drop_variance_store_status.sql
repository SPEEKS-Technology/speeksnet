-- Retire the standing "in the clear" per-store status.
--
-- It is superseded by the per-PERIOD all_clear added in 0027. The standing flag
-- was a mode you had to remember to switch back off; all_clear is a statement
-- about one report, which is what "this store had a clean month" actually means.
-- Ethan is re-uploading the July reports under the new mechanics, so there is
-- nothing to migrate forward.
--
-- For the record, the rows being dropped (as of 2026-08-11):
--   OVL  in_the_clear = true   set by Ethan Kushnir 2026-08-03
--   WSP  in_the_clear = true   set by Ethan Kushnir 2026-08-01
--   LEE  in_the_clear = false  set by Ethan Kushnir 2026-07-20
--
-- ⚠️ Run this only once the variance-replies function has been redeployed
-- without its set_store_status action and store_status payload — the deployed
-- version still selects from this table.

drop table if exists public.variance_store_status;
