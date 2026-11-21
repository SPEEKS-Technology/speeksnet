-- 0196 — Expiring Credentials: a daily warning before a key, secret, token or
-- certificate the site relies on runs out (2026-11-21).
--
-- Ethan set up the Entra app "SPEEKSNET Mail Alerts" on 2026-11-21 for the Alerts
-- Hub and its client secret (MS_CLIENT_SECRET) only lives 24 months. He asked for
-- a renewal reminder, and the same for everything else that can expire.
--
-- ONE ROW PER CREDENTIAL. Most of what the site uses never expires (Anthropic key,
-- GitHub App private key, VAPID keys, Shopify offline tokens, the ops secret) and
-- is deliberately NOT here — a row that can never fire is noise. The full
-- inventory, including the ones left out and why, is docs/credential-expiry.md.
--
--   expires_at  null  = we could not find the date; Ethan enters it by hand
--                       (see the doc). Listed at the foot of every alert so it
--                       is not forgotten, never alerted on by itself.
--   auto_source       = the credential-expiry fn refreshes expires_at itself
--                       every run. 'ebay_stores:<STORE>' reads that store's
--                       refresh_token_expires_at, which ebay-oauth writes from
--                       eBay's own refresh_token_expires_in on every reconnect.
--   notify_list       = the Email Recipients list told about this row ("who to
--                       tell"). Default 'credential_expiry'.
--
-- ALERT STAGES: 60, 30, 14, 7, 1 days before, then daily once expired. The fn
-- sends when a row enters a NEW stage (not "when days_left = 30 exactly"), so a
-- missed cron day delays a warning by a day instead of skipping it. alert_for
-- remembers which expiry date the stage belongs to — renewing (a later date)
-- resets the stages without anyone touching alert_stage.
--
-- SENT through the Gmail relay like every other Email Recipients report, not
-- notify_queue: notify_queue delivers by per-person toggles and roles, and has
-- no notion of an Email Recipients list. So notify_queue_category_check is
-- untouched here.

create table if not exists public.credential_expiry (
  key           text primary key,
  name          text not null,
  what          text not null default '',
  used_by       text not null default '',
  renew_steps   text not null default '',
  expires_at    timestamptz,
  lifetime_note text not null default '',
  auto_source   text,
  notify_list   text not null default 'credential_expiry',
  active        boolean not null default true,
  alert_stage   text,
  alert_for     timestamptz,
  last_alert_on date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- RLS on, no policy: only the service role (the edge fn) reads it. The anon key
-- has full grants in this project (see memory: supabase-rls-new-tables).
alter table public.credential_expiry enable row level security;

insert into public.credential_expiry (key, name, what, used_by, renew_steps, expires_at, lifetime_note, auto_source) values
('ms_client_secret',
 'Microsoft Entra client secret (MS_CLIENT_SECRET)',
 'Client secret of the Entra app "SPEEKSNET Mail Alerts" (client ID 286a48f2-0c82-4076-bc13-dddf07824e69). Read-only access to Ethan''s mailbox for the Alerts Hub.',
 'Alerts Hub mail reading (Microsoft Graph).',
 '1. entra.microsoft.com → Entra ID → App registrations → SPEEKSNET Mail Alerts → Certificates & secrets → New client secret (24 months).' || chr(10) ||
 '2. Copy the new secret''s VALUE (shown once).' || chr(10) ||
 '3. Supabase → Project Settings → Edge Functions → Secrets: paste it over MS_CLIENT_SECRET.' || chr(10) ||
 '4. Delete the old secret in Entra once mail reading works, then update this row''s expires_at to the new Expires date.',
 '2028-11-21 21:33:00+00',
 'Created 2026-11-21 with a 24-month lifetime. Check the Expires column in Entra if in doubt.',
 null),
('ebay_refresh_OVL', 'eBay refresh token — OVL', 'OAuth refresh token for the Overland Park eBay account.', 'SPEEKS Connect, eBay sync, claims, Net Profit eBay fees.',
 'Reconnect the store: open https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/ebay-oauth?store=OVL&secret=<ops secret> and sign in with the OVL eBay account. The new expiry is picked up automatically.',
 null, 'eBay refresh tokens last about 18 months from the last consent.', 'ebay_stores:OVL'),
('ebay_refresh_LEE', 'eBay refresh token — LEE', 'OAuth refresh token for the Lee''s Summit eBay account.', 'SPEEKS Connect, eBay sync, claims, Net Profit eBay fees.',
 'Reconnect the store: open https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/ebay-oauth?store=LEE&secret=<ops secret> and sign in with the LEE eBay account. The new expiry is picked up automatically.',
 null, 'eBay refresh tokens last about 18 months from the last consent.', 'ebay_stores:LEE'),
('ebay_refresh_WSP', 'eBay refresh token — WSP', 'OAuth refresh token for the Westport eBay account.', 'SPEEKS Connect, eBay sync, claims, Net Profit eBay fees.',
 'Reconnect the store: open https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/ebay-oauth?store=WSP&secret=<ops secret> and sign in with the WSP eBay account. The new expiry is picked up automatically.',
 null, 'eBay refresh tokens last about 18 months from the last consent.', 'ebay_stores:WSP'),
('ebay_refresh_MPL', 'eBay refresh token — MPL', 'OAuth refresh token for the Maplewood eBay account.', 'SPEEKS Connect, eBay sync, claims, Net Profit eBay fees.',
 'Reconnect the store: open https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/ebay-oauth?store=MPL&secret=<ops secret> and sign in with the MPL eBay account. The new expiry is picked up automatically.',
 null, 'eBay refresh tokens last about 18 months from the last consent.', 'ebay_stores:MPL'),
('ebay_refresh_BAL', 'eBay refresh token — BAL', 'OAuth refresh token for the Ballwin eBay account.', 'SPEEKS Connect, eBay sync, claims, Net Profit eBay fees.',
 'Reconnect the store: open https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/ebay-oauth?store=BAL&secret=<ops secret> and sign in with the BAL eBay account. The new expiry is picked up automatically.',
 null, 'eBay refresh tokens last about 18 months from the last consent.', 'ebay_stores:BAL'),
('domain_speeksnet', 'speeksnet.com domain registration', 'The domain the site is served from (GitHub Pages, see CNAME). Its HTTPS certificate renews itself; the registration does not unless auto-renew is on.',
 'Everything at speeksnet.com.',
 'Renew at the registrar the domain was bought from (or confirm auto-renew and the card on file), then set this row''s expires_at to the new date.',
 null, 'Date unknown — enter it from the registrar.', null),
('supabase_cli_token', 'Supabase CLI access token (Ethan''s PC)', 'Personal access token the Supabase CLI on Ethan''s PC uses to deploy edge functions and list secrets (npx supabase login). Not used by the running site.',
 'Edge function deploys from Ethan''s PC.',
 'supabase.com/dashboard/account/tokens → check the token''s expiry. To renew: run npx supabase login on the PC (or generate a new token there), then set this row''s expires_at — or clear it to null and mark it inactive if the token never expires.',
 null, 'Date unknown — tokens can be made with or without an expiry.', null)
on conflict (key) do nothing;

-- Same day, Ethan: ignore the domain registration and the CLI token for now.
-- Kept as rows (switched off) so turning one back on is just active = true.
update public.credential_expiry set active = false, updated_at = now()
 where key in ('domain_speeksnet', 'supabase_cli_token');

-- Pull the eBay dates in now so the first run already has them.
update public.credential_expiry c
   set expires_at = s.refresh_token_expires_at, updated_at = now()
  from public.ebay_stores s
 where c.auto_source = 'ebay_stores:' || s.store_code
   and s.refresh_token_expires_at is not null;

-- Recipients: Ethan by default. Only seeds an empty list; edits after that
-- belong to the Email Recipients tool (System Alerts → Expiring Credentials).
insert into public.email_recipients (list_key, email)
select 'credential_expiry', 'ethan.kushnir@speekstechnology.com'
where not exists (select 1 from public.email_recipients where list_key = 'credential_expiry');

-- Daily, 7:50am Central. Hourly at :50 with a Chicago-hour guard so DST never
-- moves it (same pattern as 0153/0184). The fn's last_alert_on stops a repeat.
select cron.unschedule('credential-expiry-750am') where exists (select 1 from cron.job where jobname = 'credential-expiry-750am');
select cron.schedule('credential-expiry-750am', '50 * * * *', $job$
  select net.http_get(
    url := 'https://ejzaqmyxxrkmxvzbjeuo.supabase.co/functions/v1/credential-expiry?secret=sp33ks-sync-k3y-2026-x9mq',
    timeout_milliseconds := 60000)
  where extract(hour from (now() at time zone 'America/Chicago')) = 7;
$job$);

insert into public.cron_expectations (jobname, stale_after_min, note)
values ('credential-expiry-750am', 1560, 'Fires daily 7:50am Central — allow 26h.')
on conflict (jobname) do update set stale_after_min = excluded.stale_after_min, note = excluded.note;
