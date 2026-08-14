-- TOM -> MOCD cutover. RUN THIS ONLY WHEN THE CODE IS LIVE.
--
-- users.role is the string every gate compares, and the CSS role- class is
-- derived from it, so the data and the code have to move together. Running this
-- early breaks the MOCD user on the still-deployed old code; running it late
-- breaks them on the new code. There is no safe order other than "at the same
-- time", which is why this is a checklist rather than an ordinary migration.
--
-- BEFORE running:
--   1. The branch is merged and speeksnet.com is serving speeks.js?v=20260811g
--      or later (hard-refresh and confirm ROLE_ORDER contains 'MOCD').
--   2. These three edge functions are DEPLOYED — editing them is not deploying
--      them, and each one gates on the role slug:
--        b2b-deals     ACCEPT_ROLES  — sign-off, quote send/accept, wipe cert
--        kpi-manage    EXCLUDE       — keeps the role out of store KPI grids
--        usage-report  ROSTER_EXCLUDE— keeps it out of the nightly denominator
--      All three now list BOTH spellings, so once deployed they are correct
--      either side of this migration.
--
-- Feature keys stay hb-tom-* deliberately: they are the stored identity in
-- feature_overrides and renaming them would orphan saved overrides.

update public.users
   set role = 'MOCD'
 where role = 'TOM';

update public.feature_overrides
   set subject = 'mocd'
 where subject_type = 'role'
   and subject = 'tom';
