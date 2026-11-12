-- 0180 — Day End: what the stock that is in stock is WORTH.
--
-- Ethan, 2026-11-08, on the QuickPortal Inventory card: "Show the value here
-- not the cost." The Day End email's Inventory Snapshot -> Available card is
-- three figures: Device Count / Cost / Projection. Projection is the resale
-- value of what is sitting available. sales-email-import.gs has always parsed
-- it (_wkAvailable().projection) but nothing stored it, so only the count and
-- the cost ever reached day_end_facts.
--
-- Filled by day-end-ingest from the Apps Script's availableValue. Rows from
-- before the script sends it stay null (never 0) until a backfill re-reads the
-- mail: day-end-ingest?days=N&goals=0.

alter table public.day_end_facts
  add column if not exists available_value numeric;

comment on column public.day_end_facts.available_value is
  'Day End Inventory Snapshot -> Available card -> Projection: resale value of the devices available (in stock). available_cost is the same stock at cost. Null on rows read before 2026-11-08 until backfilled.';
