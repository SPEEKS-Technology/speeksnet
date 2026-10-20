-- ============================================================================
-- 0143 — Picture Quality: what a Batch API batch is waiting on.
--
-- The nightly sweep sends new listings through Anthropic's Message Batches API
-- at half price (Ethan approved the cost cut, 2026-10-11). A batch returns in
-- minutes to hours, so the sweep (?sweep=N&batch=1) and the collection
-- (?poll=1) are separate calls. This row is what lets the second find the
-- first's work: the batch id, and per request the listing, the sheet it was
-- sent against, the stamp it was graded at (an edited listing's result is
-- dropped, not saved over new photos), and — for a second look — the first
-- look's report, so the two can be merged by agree().
--
-- A listing inside a submitted batch is never sent again until it is collected.
-- RLS on, no policy: only the edge function (service role) reads or writes it.
-- ============================================================================

create table if not exists public.pq_batches (
  id            bigserial primary key,
  store_code    text not null,
  batch_id      text not null unique,
  model         text not null,
  effort        text not null,
  items         jsonb not null,               -- { custom_id: { pid, kind, sheet, pick, reSheeted, stamp, first? } }
  status        text not null default 'submitted' check (status in ('submitted', 'done', 'failed')),
  submitted_at  timestamptz not null default now(),
  finished_at   timestamptz,
  cost_usd      numeric,
  result        jsonb                         -- { ok, failed, changed, saved, followUp, followBatch }
);

create index if not exists pq_batches_open on public.pq_batches (status) where status = 'submitted';

alter table public.pq_batches enable row level security;
