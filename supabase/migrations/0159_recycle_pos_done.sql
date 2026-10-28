-- ============================================================================
-- 0159 — Recycle requests: "Recycled in POS" stamp.
--
-- Ethan, 2026-10-28: once the DM has ruled a line For or Against store, the
-- store still has to actually recycle it out of the POS — and the manager and
-- ASM had no way to tell whether one of them had already done it, or neither.
-- A checkbox on the manager's side of the tool now stamps who ticked it and
-- when.
--
-- Two plain columns, both null until ticked; unticking clears both. The edge
-- function only accepts the tick on a line whose verdict is 'for' or 'against'
-- (the front end hides it otherwise), so a pending, denied or ignored line
-- never carries one that means anything. The stamp is NOT cleared if the DM
-- later changes the verdict — it records a thing that happened in the POS,
-- and undoing a verdict doesn't un-happen it. The box just stops showing.
-- ============================================================================

alter table public.recycle_requests add column if not exists pos_done_at timestamptz;
alter table public.recycle_requests add column if not exists pos_done_by text;
