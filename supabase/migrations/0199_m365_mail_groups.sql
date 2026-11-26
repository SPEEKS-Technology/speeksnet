-- 0199 — Alerts Hub mail reader: sort everything that isn't top tier into groups
--
-- Ethan, 2026-11-22: "I don't need to be notified that Jordan sent me an email
-- if it's just Jordan applied. I'd rather have you collect some stuff over the
-- course of the day … 'you have 6 new applicants'. … you can make judgment
-- calls to determine what should be sent out and what shouldn't be."
--
-- Day one showed why rules alone can't: Indeed sends each application under
-- the applicant's own name (four "people" counted that were applicants), and
-- SPEEKSNET's own report mail came through as five more. So every email that
-- isn't Paul / PayMore / a manager now gets a cheap Haiku 5.5 look
-- (~$0.0003 each, approved 2026-11-22) and lands in one group:
--   reply      a real person writing to Ethan who may need an answer  → 2-hour count
--   applicant  job applications (Indeed etc.)                         → 2-hour count, "6 new applicants"
--   fyi        worth a glance, nothing to do (corporate updates)      → morning digest only
--   report     automated reports and dashboards (incl. SPEEKSNET's)   → silent
--   order      orders, receipts, invoices, shipping, billing notices  → silent
--   alert      automated alerts (alarms, sign-ins, monitoring)        → silent (Ethan: Alarm.com stays quiet)
--   spam       marketing, newsletters, promotions                     → silent
-- Any of them can be escalated by the model when it truly can't wait (a
-- payment failing, an account locked) — that one pushes right away.
-- tier keeps its meaning: 'other' = counted (reply/applicant), 'noise' = not.

alter table public.m365_mail_seen add column if not exists grp text;
alter table public.m365_mail_seen add column if not exists escalated boolean;
