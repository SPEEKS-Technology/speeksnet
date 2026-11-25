-- 0179 — Returned But Not Back In Stock: "Never Came Back", confirmed by the DM.
--
-- Ethan, 2026-11-06: WSP #MO02-6752 ($899.99 ThinkPad) was refunded on eBay but
-- the unit never came back to the store. Nothing can be restocked, so no SKU
-- test will ever clear it, and Restocked Under Another SKU doesn't fit either.
--
-- A manager marks the line Never Came Back with a reason (nb_*). That does NOT
-- close it: it waits for the DM, who confirms (closes it) or denies it (it stays
-- open, and the denial shows on the next mail). The DM's own mark closes at once.
-- A new request after a denial overwrites the denial fields.

alter table public.unrestocked_returns
  add column if not exists nb_requested_at timestamptz,
  add column if not exists nb_requested_by text,
  add column if not exists nb_reason       text,
  add column if not exists nb_denied_at    timestamptz,
  add column if not exists nb_denied_by    text,
  add column if not exists nb_denied_note  text;

comment on column public.unrestocked_returns.nb_requested_at is
  'A manager said the unit never came back (nb_reason). Pending until the DM confirms (resolves the row) or denies (nb_denied_*, request cleared).';
