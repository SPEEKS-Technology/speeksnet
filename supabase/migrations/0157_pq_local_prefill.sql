-- ============================================================================
-- 0157 — Picture Quality: the LOCAL model's answers, as a free prefill for
-- Confirm Shots.
--
-- More For Training ran dry on 10-21: every Opus-graded listing was confirmed,
-- and grading more with Opus costs ~$0.26 a listing. Ethan (2026-10-22) chose
-- to prefill the next labelling batch with the local model instead (Qwen2.5-VL
-- 7B + his-labels-only LoRA, tools/pq-train). It runs on his laptop and costs
-- nothing, and nothing here is Claude output. tools/pq-train/prefill.py picks
-- never-graded live listings by title, runs the model, and loads one row per
-- listing here. The picture-quality function's More For Training offers them
-- with shots, closeup and reflection prefilled and everything else blank.
--
--   photos — [{n, src, shots, closeup, reflection}] in the listing's order on
--            the day it ran. src is the CDN address without its query, the
--            key pq_shot_labels uses, so a photo retaken or reordered since
--            is caught rather than mislabelled (the pre-10-14 reorder bug
--            prefilled four listings with shifted labels exactly that way).
--   sheet_slug — the sheet guessed from the title; he can change it.
--   model  — which local run answered (e.g. 'local-r4'), carried onto the
--            saved labels so his changes can be measured against it.
--
-- Written by prefill.py through the Supabase CLI and read by the
-- picture-quality function (service role). RLS on with no policy, the pattern
-- for new tables here: anon's default grants then mean nothing.
-- ============================================================================
create table if not exists public.pq_local_prefill (
    store_code  text not null,
    product_id  text not null,
    sheet_slug  text not null,
    title       text,
    model       text not null,
    photos      jsonb not null,
    created_at  timestamptz not null default now(),
    primary key (store_code, product_id)
);
comment on table public.pq_local_prefill is
  'Picture Quality: the local model''s shot/closeup/reflection answers for never-graded listings, a free prefill for Confirm Shots (More For Training). Loaded by tools/pq-train/prefill.py. See 0157.';
alter table public.pq_local_prefill enable row level security;
revoke all on public.pq_local_prefill from anon, authenticated;
