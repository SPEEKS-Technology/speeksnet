-- 0184 — Facebook Boosts: the weekly email, Mondays 8:30am Central (2026-11-13),
-- with the Weekly Report (weekly-report-mon-*), the usual Monday send time.
--
-- fb-boost-report mails last week's boosts (recorded with Mark Boosted in the
-- Marketplace Lister's Listed tab) to the fb_boosts list, falling back to
-- claims_disputes_dm while that list is empty.
--
-- Same pattern as 0153: fire hourly at :30 and let the Chicago-hour guard pick
-- 8, so DST never moves the send. The weekday guard is also read in Chicago
-- time, so the mail can't go out on Sunday night UTC.

select cron.unschedule('fb-boost-report-mon-830am') where exists (select 1 from cron.job where jobname = 'fb-boost-report-mon-830am');
select cron.schedule('fb-boost-report-mon-830am', '30 * * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/fb-boost-report?secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 140000)
  where extract(hour from (now() at time zone 'America/Chicago')) = 8
    and extract(isodow from (now() at time zone 'America/Chicago')) = 1;
$job$);

-- Recipients: Ethan + Paul (Ethan asked for Paul, 2026-11-13). Seeded here
-- because an empty list falls back to claims_disputes_dm, so adding Paul alone
-- would quietly drop Ethan. Only seeds an empty list; edits after that belong
-- to the Email Recipients tool.
insert into public.email_recipients (list_key, email)
select 'fb_boosts', e from unnest(array[
  'ethan.kushnir@speekstechnology.com',
  'paul.kushnir@pikinvestments.com']) as e
where not exists (select 1 from public.email_recipients where list_key = 'fb_boosts');

-- Once a week: allow 7 days + 2h.
insert into public.cron_expectations (jobname, stale_after_min, note)
values ('fb-boost-report-mon-830am', 10200, 'Fires Mondays 8:30am Central once a week — allow 7d+2h.')
on conflict (jobname) do update set stale_after_min = excluded.stale_after_min, note = excluded.note;
