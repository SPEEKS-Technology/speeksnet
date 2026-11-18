-- 0166 — Returned But Not Back In Stock: "Restocked Under Another SKU".
--
-- Ethan, 2026-11-04: BAL #MO04-3622 (a JMGO projector listed as the wrong
-- model) was returned and put back in stock under a DIFFERENT listing, the one
-- that matched what it really was (MO04-2508D-R3R2). The report only ever
-- looks at the refunded line's own SKU, which stays at 0 for good, so the row
-- would have stayed on the morning mail forever.
--
-- The mail now carries a link to speeksnet.com (index.html#restock=<key>). A
-- manager logs in, types the SKU it went back under, and the function checks
-- that SKU is on hand or has sold since the refund before closing the row. A
-- SKU that fails the check does NOT close anything; it is logged in `attempts`
-- so the DM sees on the next mail that somebody tried and what was wrong.
--
--   moved_to_sku       the SKU it went back in under (null for every other close)
--   closed_by          display name of whoever closed it from the app — the
--                      same free-text, browser-asserted name as everywhere else
--                      on this site (no real identity; see CLAUDE.md)
--   attempts           [{at, by, sku, why}] — every SKU that was tried and refused
--   closure_mailed_at  when the "Closed By A Manager" line went out, so the DM
--                      sees each manual close exactly once

alter table public.unrestocked_returns
  add column if not exists moved_to_sku text,
  add column if not exists closed_by text,
  add column if not exists attempts jsonb not null default '[]'::jsonb,
  add column if not exists closure_mailed_at timestamptz;
