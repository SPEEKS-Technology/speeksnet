-- ============================================================================
-- daily_np + monthly_np_goals — Net Profit becomes a number the site can read.
--
-- WHY THIS EXISTS (2026-10-02). From October the company is graded on Net
-- Profit, not Gross Profit (Paul's call, made at the start of the month with no
-- run-up). Until now NP has lived ONLY on the "Net Profit {Mon} {YY}" tabs of the
-- Sales Summary 2026 workbook: netprofit-collect works each store-day out live
-- from Shopify + eBay, the Apps Script writes it to the tab, and nothing keeps
-- it. Every "net" figure the site has shown so far was GP less a flat 21% of
-- revenue (BD_NET_GP_RATE), never the real fees.
--
-- THE SHEET IS THE SOURCE, ON PURPOSE. daily_np is a MIRROR of the NP tab, filled
-- by the np-sync edge function reading the tab through gviz. It is not filled by
-- calling netprofit-collect again, because:
--   * the tab is what Paul and Ethan read and what was proven against the P&L
--     through September — a second computation could only ever disagree with it;
--   * Ethan hand-corrects cells on the tab when the P&L lands, and a mirror keeps
--     those corrections where a re-collect would silently undo them;
--   * reading a sheet takes no Apps Script lock. The 6:05/6:10 import + Net
--     Profit passes already fight over one LockService lock (2026-09-12), and
--     nothing new may be put on that project's minutes.
--
-- ROYALTY is stored, not re-derived: the tab's NP is
--     Sales − Cost − eBay fee − Shipping − Card fee − 7% of Sales
-- and np-sync writes royalty = GP − eBay − Shipping − Card − NP, so the row's
-- parts always add up to the NP the tab shows, even if the rate ever changes.
--
-- SHIPPING IS LATE. The 6:10am pass writes everything EXCEPT shipping; shipping
-- for a day is final from the 2:05pm pass the next day. A blank shipping cell is
-- stored as NULL (not 0), and `shipping_final` says whether that day's shipping
-- can still move — so a morning NP that has not paid for its labels yet is never
-- mistaken for a final one.
--
-- AUGUST HAS NO TAB and is deliberately not back-filled (Ethan, 2026-10-02): its
-- closed-month re-read is ~$21k off the P&L after the mass eBay/Shopify refund
-- mess, and the hand-typed Last Month cells on the Sep tab are the agreed August.
-- History here starts with September.
--
-- Both tables: RLS on with no policy, read and written only by edge functions
-- with the service key, same as netprofit_runs.
-- ============================================================================

create table if not exists public.daily_np (
  date            date        not null,
  store           text        not null,          -- OVL LEE WSP MPL BAL
  sales           numeric,                       -- net sales (+1 on the tab)
  cost            numeric,                       -- COGS (+4)
  gp              numeric,                       -- sales − cost (+5)
  ebay_fee        numeric,                       -- (+9)  NULL = the eBay pass failed (=NA())
  shipping_cost   numeric,                       -- (+10) NULL = not written yet
  cc_fee          numeric,                       -- (+11)
  royalty         numeric,                       -- gp − ebay − ship − cc − np
  np              numeric,                       -- (+12)
  shipping_final  boolean     not null default false,
  source_tab      text,
  synced_at       timestamptz not null default now(),
  primary key (date, store)
);

create index if not exists daily_np_store_date_idx on public.daily_np (store, date);
alter table public.daily_np enable row level security;

comment on table public.daily_np is
  'Per store per day Net Profit, mirrored from the workbook''s "Net Profit {Mon} {YY}" tab by '
  'np-sync. The tab is the source; corrections are made there, never here.';

-- The month's NP goal per store. Set on SPEEKS (Month Setup, through gp-goals)
-- and pushed to the tab's "NP Goal" cell — the same site -> sheet direction as
-- the GP goal. monthly_gp_goals is kept as it is for the GP history.
create table if not exists public.monthly_np_goals (
  id       bigint generated always as identity primary key,
  store    text        not null,
  ym       text        not null,                 -- YYYY-MM
  np_goal  numeric     not null,
  set_by   text,
  set_at   timestamptz not null default now(),
  unique (store, ym)
);

alter table public.monthly_np_goals enable row level security;

comment on table public.monthly_np_goals is
  'Monthly Net Profit goal per store. Written by gp-goals (Month Setup); pushed to the NP tab''s goal cell.';

-- September's NP goals were typed straight onto the "Net Profit Sep 26" tab
-- (read 2026-10-02: 51k/40k/52k/46k/38k = 227k). Carried in so September has a
-- goal on SPEEKS too, and October's comparisons have something to stand on.
insert into public.monthly_np_goals (store, ym, np_goal, set_by)
values ('OVL','2026-09',51000,'sheet'), ('LEE','2026-09',40000,'sheet'),
       ('WSP','2026-09',52000,'sheet'), ('MPL','2026-09',46000,'sheet'),
       ('BAL','2026-09',38000,'sheet')
on conflict (store, ym) do nothing;
