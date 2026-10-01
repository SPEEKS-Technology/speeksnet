-- ============================================================================
-- netprofit_runs — where each Net Profit pass got to, phase by phase.
--
-- WHY THIS EXISTS (2026-09-17). The Net Profit refresh runs in Apps Script, whose
-- execution log cannot be read from anywhere but the script editor. Two mornings
-- running, the watchdog reported the pass "last finished never" and restarted it,
-- and working out WHY took most of a morning of inference from the outside: the
-- collector calls in the edge logs, the workbook's last-modified time, and which
-- emails had and had not arrived. Yesterday's 2pm pass had provably reached the
-- "figures changed" report and still never recorded finishing — and nothing
-- anywhere said which step it died in.
--
-- So every pass now posts a row as it clears each phase (start, grid written,
-- health sent, summary, report, YoY, done). A pass killed at Apps Script's six-
-- minute wall runs no catch block and sends no email — but its LAST ROW here
-- still says exactly how far it got and how many seconds it had used. That turns
-- "why did this not finish" into one query.
--
-- Written only by the netprofit-runlog edge function (ops secret). RLS on with
-- no policy, same as ebay_alert_state: nothing reads it with an anon key.
-- ============================================================================

create table if not exists public.netprofit_runs (
  id          bigint generated always as identity primary key,
  -- One pass. Chosen by the script: '<Central date> <pass> <epoch ms>', so rows
  -- from a pass and its watchdog restart are told apart without a join.
  run_id      text        not null,
  pass        text        not null,         -- 'morning' | 'afternoon' | 'close' | 'tail'
  trigger     text,                         -- 'cron' | 'restart' | 'tail-recovery' | 'manual'
  phase       text        not null,
  ok          boolean     not null default true,
  -- Milliseconds since the pass began, as Apps Script measured it. The wall is at
  -- 360000; a last row near it is the signature of a killed execution.
  elapsed_ms  integer,
  detail      jsonb,
  at          timestamptz not null default now()
);

create index if not exists netprofit_runs_at_idx on public.netprofit_runs (at desc);
create index if not exists netprofit_runs_run_idx on public.netprofit_runs (run_id, at);

alter table public.netprofit_runs enable row level security;

comment on table public.netprofit_runs is
  'Phase-by-phase progress of each Net Profit pass, posted by Apps Script through '
  'the netprofit-runlog edge function. The last row of a run says where it stopped.';
