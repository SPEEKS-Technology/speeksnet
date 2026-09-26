-- 0104 — an escalated return is ONE item, not two.
--
-- When a buyer escalates a return, eBay opens a separate case for the same sale.
-- The 2026-09-22 OVL check found 15 of 17 "return" cases sitting in the tool
-- beside the return they came from, so the same money was counted twice. The
-- case's detail names its return (returnId); the search summary does not, so it
-- is read once per case and kept here. '' means "read, names no return".
--
-- claims-disputes then shows one card per sale: the case (the live stage), with
-- the return's id, title and amount folded in, and the return itself left out.
alter table public.ebay_cases add column if not exists return_id text;
create index if not exists ebay_cases_return_id_idx on public.ebay_cases (store_code, return_id)
  where return_id is not null and return_id <> '';
