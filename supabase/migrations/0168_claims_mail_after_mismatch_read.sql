-- 0168 — the claims mails go out AFTER the refund-mismatch read, not beside it.
--
-- Found 2026-11-04. refund-mismatch runs at 8:20 CT (0089) and the managers'
-- claims mail ALSO ran at 8:20. The mails went at 8:20:26–30; the mismatch read
-- finished writing at 8:20:57. So every manager mail carried YESTERDAY's
-- mismatches, while the DM digest at 8:25 carried today's — and its footer says
-- "this is what went out to them today". That morning: OVL got no mail at all
-- although a $1,649.99 mismatch (#KS01-15531) was found 31 seconds later, and
-- BAL was mailed a $39.99 mismatch (#MO04-3752) the same read had just closed.
--
-- Now: manager mail 8:35, DM digest 8:40. An edge function's wall clock is
-- capped at 400s, so a read started at 8:20 has finished by 8:26:40 — the
-- margin is structural, not a guess about how long a read usually takes. The
-- digest also re-uses the 8:35 sweep (claims-disputes throttles a store to one
-- read per 20 min), so it describes the same data the managers were sent.
--
-- The job NAMES still say 820am / 825am; pg_cron can't rename in place and
-- cron health keys on the name. The schedule is what counts.
select cron.alter_job((select jobid from cron.job where jobname = 'claims-disputes-manager-daily-820am'), schedule := '35 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'claims-disputes-dm-digest-825am'),    schedule := '40 * * * *');
