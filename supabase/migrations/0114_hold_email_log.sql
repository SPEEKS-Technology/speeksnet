-- 0114 — what the Claims & Disputes emails have already said, and to whom.
--
-- WHY THIS EXISTS. Three of the tool's rules are about REPETITION, and none of
-- them can be answered from the item alone:
--
--   * "once they are notified about it via email, they don't need to see it
--     again until the day of needing to refund" (Ethan, 2026-09-23, on INRs).
--     Whether an INR goes quiet depends on whether it was ever sent, which is
--     not a fact about the INR.
--   * "New since yesterday" on the manager email — new means not in yesterday's.
--   * The 4:00 PM nudge fires only when "nothing has changed since the morning
--     email", so it has to know what the morning email said.
--   * A missed reply window is shown to the DM ONCE. There is nothing to clear,
--     so without a record of having said it, it would repeat every morning
--     forever.
--
-- One row per ITEM per email that mentioned it, not one row per email. The
-- questions above are all of the form "when did we last tell someone about THIS
-- item", so the item is the grain. A send that mentions nothing (there is
-- nothing to say, so no mail goes out) writes no rows at all — an absence of
-- rows for today means "we said nothing", which is exactly right.
--
-- `sent_on` is the CHICAGO calendar day, not a timestamp, because every rule
-- above is phrased in days and the stores are all Central. `sent_at` keeps the
-- real instant for anyone auditing later.

create table if not exists public.hold_email_log (
  id          bigserial primary key,
  -- which of the emails: manager_daily, manager_nudge, dm_digest, dm_due_today
  kind        text        not null,
  store_code  text,
  -- mismatch | ebay_case | dispute — the same item_type the rest of the feature
  -- uses, so a row here joins straight onto hold_reviews and hold_claim_links.
  item_type   text        not null,
  item_key    text        not null,
  -- the state stateOf gave it at send time. Kept so "what changed since the
  -- morning" is answerable without re-deriving what the morning thought.
  state       text,
  sent_on     date        not null,
  sent_at     timestamptz not null default now()
);

-- "has this item ever been emailed, and when last" — the INR quiet rule.
create index if not exists hold_email_log_item_idx
  on public.hold_email_log (item_type, item_key, sent_on desc);

-- "what did this email say today / yesterday" — new-since-yesterday, the nudge,
-- and the DM's shown-once.
create index if not exists hold_email_log_kind_day_idx
  on public.hold_email_log (kind, sent_on desc, store_code);

-- Same posture as every other table this feature added: anon holds full grants
-- on this schema, so RLS ON WITH NO POLICY is what actually closes it. The edge
-- functions reach it with the service key, which bypasses RLS. See 0112.
alter table public.hold_email_log enable row level security;
