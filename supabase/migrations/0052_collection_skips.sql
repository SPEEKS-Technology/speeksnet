-- ============================================================================
-- 0052_collection_skips — a reviewer's "not this one".
--
-- Without it the queue re-offers a rejected proposal every time somebody opens
-- the panel, which trains people to ignore the panel. Skipping is per PRODUCT,
-- never per rule: the rule may be right about the other forty titles it caught,
-- and a rule that is genuinely wrong should be edited in collection_rules where
-- the reason can be written down.
-- ============================================================================

create table if not exists collection_skips (
  store_code  text not null,
  product_id  text not null,
  skipped_by  text,
  reason      text,
  created_at  timestamptz not null default now(),
  primary key (store_code, product_id)
);

-- House posture: RLS on, no policies. See [[db-rls-convention]].
alter table collection_skips enable row level security;
