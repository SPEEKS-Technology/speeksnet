-- Margin Guide, phase 3: make the coaching TEXT editable by DMs.
--
-- Phase 2 (0007) gave the DM control of the percentages. Everything a buyer
-- actually reads, though, is still frozen at whatever the VBA workbook said:
-- the "Before you buy" hero card, the Reminders / Testing Tips / Condition Help
-- lists, and the rebuttals. Those are the parts that go stale fastest — a
-- carrier stops being worth avoiding, a new lock shows up, a rebuttal turns out
-- to land badly on the floor — and they were the one thing nobody could change
-- without a migration.
--
-- WHY THIS IS A DIRECT EDIT AND THE PERCENTAGES WERE NOT
--   0007 deliberately avoided mutating mg_tiers, because the ten tiers are
--   SHARED: retuning "Standard" to fix Video Games would silently move ~100
--   unrelated cells. Text has no such coupling. help_key is very nearly 1:1
--   with a device — of 35 keys across 40 devices, exactly two are shared
--   (Audio/Home Theatre covers 4 items, Miscellaneous covers 3). So a delta
--   layer would be pure ceremony here: editing the row IS the intent. The two
--   shared keys are handled by telling the DM in the UI how many items a given
--   block of text reaches before they save.
--
-- All this migration needs to add is accountability. mg_tiers already carries
-- updated_by / updated_at; the text tables never did, because until now nothing
-- could write to them. Same columns, same reason: when a rebuttal reads oddly
-- six months from now, the useful question is who changed it and when.

alter table public.mg_help_items
  add column if not exists updated_by text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.mg_rebuttals
  add column if not exists updated_by text,
  add column if not exists updated_at timestamptz not null default now();

-- Editing walks rows in (help_key, kind, is_gate) order — a gate is lifted out
-- of its own kind list for display, so the hero card and the list it came from
-- are two separate orderings that both need to be stable. The 0005 index leads
-- on (help_key, kind, sort_order) and doesn't know about is_gate, so reordering
-- inside the hero card had no index to lean on.
create index if not exists mg_help_items_group_idx
  on public.mg_help_items (help_key, kind, is_gate, sort_order);

-- Guard against the one bad state the editor could otherwise produce. A row
-- whose body is blank renders as an empty bullet in the buyer's list: invisible
-- to whoever created it, confusing to everyone after. The UI blocks it too, but
-- the UI is not where correctness should live.
alter table public.mg_help_items
  drop constraint if exists mg_help_body_present;
alter table public.mg_help_items
  add constraint mg_help_body_present check (length(btrim(body)) > 0);

alter table public.mg_rebuttals
  drop constraint if exists mg_rebuttal_text_present;
alter table public.mg_rebuttals
  add constraint mg_rebuttal_text_present
  check (length(btrim(name)) > 0 and length(btrim(why)) > 0);

-- `say` is the line a buyer reads to the customer and stays nullable (most rows
-- seeded from the workbook only have `why` — the tool falls back to it). But an
-- EMPTY string is different from absent: it would make the tool render a blank
-- quote where it should be showing the fallback. Normalise it away.
alter table public.mg_rebuttals
  drop constraint if exists mg_rebuttal_say_not_blank;
alter table public.mg_rebuttals
  add constraint mg_rebuttal_say_not_blank
  check (say is null or length(btrim(say)) > 0);

-- RLS stays on with no policies, matching every other table here: the anon key
-- ships inside speeks.js, so all reads and writes go through the edge function
-- on the service role, which is where the role gate lives.
alter table public.mg_help_items enable row level security;
alter table public.mg_rebuttals  enable row level security;
