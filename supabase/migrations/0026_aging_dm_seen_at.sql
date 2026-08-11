-- Aging Inventory: track when the DM last LOOKED at an item.
--
-- Until now the DM's review nag was pure state: "the store replied last and the
-- reply window has closed" meant "your review", forever. But the DM answering is
-- optional by design — if they read the store's reply and it needs nothing more,
-- the item is simply parked until it sells or they follow up later. With no
-- record of having looked, those items nagged every sign-in indefinitely. BAL had
-- six of them: Joseph replied "repriced" / "fixed new title" on Aug 1, Ethan read
-- them, and the queue never emptied.
--
-- dm_seen_at is the DM-side twin of recycle_requests.dm_seen_at. The review queue
-- becomes "store replies newer than the last time I looked at this item", so
-- reading clears it and only a genuinely NEW reply brings it back.

alter table public.aging_items
  add column if not exists dm_seen_at timestamptz;

comment on column public.aging_items.dm_seen_at is
  'When the DM last viewed this item in the tool. The review notification counts an item only when its newest store note is newer than this. Null = never looked at.';

-- Backfill: everything currently open and already answered by the store is work
-- the DM has had in front of them for days. Starting them all at "unseen" would
-- fire one last giant nag on deploy for items that are, in practice, done.
-- Stamp them seen as of now; a store reply after this moment nags normally.
update public.aging_items
   set dm_seen_at = now()
 where dm_seen_at is null
   and status = 'open';
