-- ============================================================================
-- B2B notification rework (Nick, 2026-10-16).
--
-- What was asked:
--   * Stores: a DAILY reminder while a deal is in pricing, saying when it has to
--     be finished. Due is always one week from the day it entered pricing.
--   * Stores: once in listing, a WEEKLY (Monday) note of the combined unlisted
--     B2B value at that location, across every deal it holds.
--   * Corp: the same, except the weekly one covers every store with a per-store
--     breakdown, and corp can switch these off on the site.
--   * Optional email for each of these, for everybody.
--
-- Three pieces of schema, one view:
--
-- 1. B2B gets its OWN email category, `b2b`. Its alerts used to ride under
--    `requests` ("Requests Waiting On Me") as one sub-switch. With three B2B
--    notifications now -- stage updates, pricing due, unlisted value -- that is
--    a category of its own, and it lets someone keep purchase/recycle requests
--    while dropping B2B, or the reverse. cat_b2b defaults true like every other
--    category, so the switch only matters once somebody turns alerts on.
--    notify_queue's category CHECK gains 'b2b' because b2b-deals now queues its
--    stage events under it.
--
-- 2. feed_muted: the ON-SITE half. Email has always been opt-in per person; the
--    feed cards have never had a switch at all. Nick: corp can turn these off,
--    stores cannot. The notify function enforces that on save (it strips the
--    list for any role that is not corp), so this column is just storage.
--
-- 3. Provenance for two columns already live but never written into a
--    migration: user_notify_prefs.muted_kinds and notify_queue.audience_feature.
--    Both were applied by hand while the B2B notifications landed (2026-09-07).
--    `if not exists` makes these no-ops on production and correct on a rebuild.
--
-- 4. b2b_unlisted_value: what is still waiting to be listed, per deal per
--    listing store. The digest email (notify) and the feed card (b2b-deals GET
--    ?unlisted=) both read it, so the two can never disagree about a number.
--      * listing stage only -- before acceptance nothing is ours to list;
--      * the line's store, falling back to the deal's for any line that
--        predates 0081's per-item stamping;
--      * a store's part that has been signed off is excluded, even while the
--        deal is still open waiting on another store;
--      * recycle lines are worth nothing (their value is CHECKed to 0 anyway),
--        and units already listed or recycled out are not "unlisted".
--    The same unit formula the board's outstanding_units uses.
--
-- Applied via Supabase MCP `apply_migration` on 2026-10-16. NUMBERING: first written
-- as 0141/0142 off pre-release, whose highest file was 0140 -- but Ethan's
-- unmerged Main-November-Update-2 branch had already applied 0141-0147. Renamed
-- here to follow it; the database's migration history still records this one
-- under its original 014x name.
-- ============================================================================

alter table public.user_notify_prefs
  add column if not exists cat_b2b boolean not null default true;

alter table public.user_notify_prefs
  add column if not exists feed_muted text[] not null default '{}';

alter table public.user_notify_prefs
  add column if not exists muted_kinds text[] not null default '{}';

alter table public.notify_queue
  add column if not exists audience_feature text;

alter table public.notify_queue drop constraint if exists notify_queue_category_check;
alter table public.notify_queue add constraint notify_queue_category_check
  check (category = any (array[
    'announcements', 'store_messages', 'requests', 'claims',
    'variance_aging', 'deadlines', 'scores', 'b2b'
  ]));

create or replace view public.b2b_unlisted_value
with (security_invoker = true) as
select
  d.id                                             as deal_id,
  (c.acronym || '-' || lpad(d.deal_no::text, 3, '0')) as ref,
  c.company,
  coalesce(i.listing_store, d.listing_store)       as store,
  d.stage_changed_at                               as listing_since,
  count(*) filter (where i.quantity - i.listed_qty - i.recycled_qty > 0) as open_lines,
  sum(greatest(i.quantity - i.listed_qty - i.recycled_qty, 0))           as unlisted_units,
  sum(case when i.disposition = 'recycle' then 0
           else i.value * greatest(i.quantity - i.listed_qty - i.recycled_qty, 0) end)
                                                   as unlisted_value
from public.b2b_deals d
join public.b2b_clients c    on c.id = d.client_id
join public.b2b_deal_items i on i.deal_id = d.id
where d.stage = 'listing'
  and coalesce(i.listing_store, d.listing_store) is not null
  and not exists (
    select 1 from public.b2b_deal_listing_parts pt
     where pt.deal_id = d.id
       and pt.store = coalesce(i.listing_store, d.listing_store))
group by d.id, c.acronym, d.deal_no, c.company, d.stage_changed_at,
         coalesce(i.listing_store, d.listing_store)
having sum(greatest(i.quantity - i.listed_qty - i.recycled_qty, 0)) > 0;

revoke all on public.b2b_unlisted_value from anon, authenticated;
