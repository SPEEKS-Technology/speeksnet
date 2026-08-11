-- Variance Replies: target a report at specific BUYERS rather than the whole store.
--
-- Today a report is all-or-nothing: every line at/below -10% lands on the
-- manager. When 3 of 4 buyers were fine, that buries the one conversation worth
-- having. The DM now picks the buyers who owe replies, and only their lines
-- carry a note box.
--
-- Everything here is additive and defaults to today's behaviour:
--   selected_buyers NULL  = whole-store report, exactly as now
--   needs_reply     TRUE  = this line is an obligation, as every line is now

alter table public.variance_reply_periods
  add column if not exists selected_buyers text[],
  add column if not exists all_clear boolean not null default false,
  add column if not exists all_clear_by text,
  add column if not exists all_clear_at timestamptz;

comment on column public.variance_reply_periods.selected_buyers is
  'Buyer names the DM flagged for replies. NULL = whole-store report (legacy/default behaviour).';
comment on column public.variance_reply_periods.all_clear is
  'Store had nothing worth replying to this period. The manager is still notified and still reviews the report — only the reply obligation is lifted.';

-- needs_reply separates an obligation from context. A store-wide read-only view
-- still shows every <=-10% line; only these carry a note box and only these
-- count toward the dots, the due date and the awaiting_reply totals.
alter table public.variance_reply_items
  add column if not exists needs_reply boolean not null default true;

comment on column public.variance_reply_items.needs_reply is
  'True = the manager must explain this line. False = imported for context only (shown read-only in the whole-store view). Legacy rows are all true.';

create index if not exists variance_reply_items_period_needs_reply_idx
  on public.variance_reply_items (period_id, needs_reply);
