-- 0107 — "have we actually answered eBay?", and the gate that comes with it.
--
-- Ethan, 2026-09-22: a case (and later a payment dispute or a chargeback) may
-- only change status AFTER the manager says they responded to it. If they have
-- not responded, the status does not change — answering these is the whole
-- point, so the tool must not let a check-in quietly hide one.
--
-- TWO independent records, deliberately:
--
--   ebay_cases.seller_replied_at / buyer_acted_at — what EBAY says. The case and
--   inquiry history stamps every entry BUYER / SELLER / SYSTEM, so the last word
--   on a case tells us whose move it is. Checked 2026-09-22 against live data:
--   LEE inquiry 5386999585 has a SELLER entry (we provided tracking) and reads
--   WAITING_BUYER_RESPONSE; BAL case 5384957079 has only the buyer's opening
--   entry, status OPEN, and its respond-by date passed on 2026-09-14.
--
--   hold_replies — what the MANAGER says. Pressing "Mark it responded" records
--   who said so and which deadline they were answering. It unlocks the status
--   buttons and quiets the item for its timeframe, but it does NOT settle the
--   question: if eBay still shows no reply from us when that runs out, the item
--   comes back. The manager's word is the receipt, eBay's history is the truth.
alter table ebay_cases
  add column if not exists seller_replied_at timestamptz,
  add column if not exists buyer_acted_at    timestamptz;

comment on column ebay_cases.seller_replied_at is
  'Latest SELLER entry in the eBay case/inquiry history — when WE last answered.';
comment on column ebay_cases.buyer_acted_at is
  'Latest BUYER entry — if this is newer than seller_replied_at, eBay is waiting on us.';

create table if not exists hold_replies (
  item_type  text        not null,
  item_key   text        not null,
  store_code text        not null,
  -- the deadline this was answering, so a NEW eBay deadline is a new question
  respond_by timestamptz,
  marked_at  timestamptz not null default now(),
  by_name    text,
  primary key (item_type, item_key)
);

create index if not exists hold_replies_store_idx on hold_replies (store_code);

comment on table hold_replies is
  'A manager saying "I answered this on eBay". Gates the status buttons (0107).';
