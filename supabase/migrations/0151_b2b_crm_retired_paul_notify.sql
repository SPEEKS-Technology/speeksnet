-- 0151 -- The CEO mini CRM is retired; Paul's B2B email moves to his own settings
--
-- Nick, 2026-10-21: "I need the CEO Mini CRM to be destroyed. i need to make
-- sure the email to Paul.kushnir@pikinvestments.com for the CEO is for when a
-- quote is approved and needs to be sent to the client. have this in their
-- notification settings for B2B but have all of their b2b notifications on by
-- default. Ensure that email is enabled".
--
-- THE CRM. Per-client check-in reminders (b2b_clients.outreach_*), a queue of
-- unscheduled clients, and one notification address with two switches -- the
-- daily "N clients are due a check-in" digest and the quote-ready email. The
-- UI is removed from the site in the same change. Here:
--   * both daily sweep jobs are unscheduled (0008 created them), so the digest
--     stops;
--   * the CRM's own quote-ready email is switched off (quote_ready_enabled),
--     because the same event now reaches Paul through his notification
--     settings and two copies of one email is how people learn to ignore it.
-- NOTHING IS DROPPED. b2b_crm_settings stays because it also holds the
-- certified-wipe fee b2b-deals prices with (wipe_fee, $8.00); the outreach
-- columns and b2b_outreach_log keep their history. To bring the digest back,
-- re-run 0008 and set enabled = true.
--
-- PAUL'S SETTINGS. He had no user_notify_prefs row at all, and no row means no
-- email (notify's wants() needs enabled + an address). "A quote is ready to
-- send" is the b2b_quote_ready kind, which sits under the B2B sub "B2B Deals
-- Waiting On Me" and is queued to the accept roles (CEO included) the moment
-- pricing is submitted -- so it is already a B2B notification setting; it only
-- needed somewhere to go. The row is keyed the way the Settings screen keys it,
-- the lowercased display name.
--   * email on, instant, to the pikinvestments address;
--   * every B2B switch on: cat_b2b, and no b2b kinds muted for email or the feed;
--   * the NON-B2B categories off. He was asked for B2B, and a CEO switched on
--     to every announcement, claim and variance email on day one is a CEO who
--     turns email off. Each is one toggle in Settings if he wants them.
-- No welcome email is sent: that is the Settings screen's save, not this row.

select cron.unschedule('b2b-outreach-daily-cdt')
where exists (select 1 from cron.job where jobname = 'b2b-outreach-daily-cdt');
select cron.unschedule('b2b-outreach-daily-cst')
where exists (select 1 from cron.job where jobname = 'b2b-outreach-daily-cst');

update public.b2b_crm_settings
   set enabled = false,
       quote_ready_enabled = false,
       updated_by = '0151 (CRM retired)',
       updated_at = now()
 where id = 1;

insert into public.user_notify_prefs
    (user_name, email, enabled, cadence,
     cat_b2b, cat_announcements, cat_store_messages, cat_requests, cat_claims,
     cat_variance_aging, cat_deadlines, cat_scores, cat_categories, cat_listing_photos,
     muted_kinds, feed_muted, updated_at)
values
    ('paul kushnir', 'paul.kushnir@pikinvestments.com', true, 'instant',
     true, false, false, false, false,
     false, false, false, false, false,
     '{}', '{}', now())
on conflict (user_name) do update
   set email       = excluded.email,
       enabled     = true,
       cat_b2b     = true,
       -- Unmute anything B2B he may have muted, keep anything else as he left it.
       muted_kinds = array(select k from unnest(user_notify_prefs.muted_kinds) k where k not like 'b2b%'),
       feed_muted  = array(select k from unnest(user_notify_prefs.feed_muted) k where k not like 'b2b%'),
       updated_at  = now();
