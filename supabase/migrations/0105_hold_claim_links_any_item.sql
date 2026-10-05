-- 0105 — a MISMATCH can hold a claim too, not just an item-not-received.
--
-- Ethan, 2026-09-22: "if it is a claim that gets opened, then the current rules
-- for reminding about open claims is the norm for them. same with INR claims."
-- So once a claim exists for a mismatch, the mismatch stops running its own
-- 3-day check-in: the claim's own 7-day cycle in the Claims tab takes over, and
-- the mismatch settles when the claim is Recovered or Denied.
--
-- hold_claim_links was keyed by case_key (an ebay_cases row). It is now keyed
-- the same way hold_reviews and hold_review_events are: (item_type, item_key).
alter table public.hold_claim_links add column if not exists item_type text;
alter table public.hold_claim_links add column if not exists item_key text;
update public.hold_claim_links set item_type = coalesce(item_type, 'ebay_case'), item_key = coalesce(item_key, case_key);
alter table public.hold_claim_links alter column item_type set not null;
alter table public.hold_claim_links alter column item_key set not null;
alter table public.hold_claim_links add constraint hold_claim_links_item_type_check
  check (item_type in ('mismatch', 'ebay_case', 'chargeback'));
-- case_key stays for the eBay rows that have one, but the key is now the pair.
-- The primary key goes FIRST: a column cannot drop NOT NULL while it is in one.
alter table public.hold_claim_links drop constraint if exists hold_claim_links_pkey;
alter table public.hold_claim_links alter column case_key drop not null;
alter table public.hold_claim_links add primary key (item_type, item_key);
