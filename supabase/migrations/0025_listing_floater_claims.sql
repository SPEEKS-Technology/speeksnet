-- Applied 2026-08-10.
--
-- A floater (users.can_float) belongs to a MARKET, not a store: Zach Marchesano's
-- home store is OVL but he goes wherever KC needs help that day. Every manager in
-- the market therefore sees him in their roster, and the first one to give him a
-- role that day claims him — he greys out for the others.
--
-- ⚠️ This is a separate table rather than a unique index on
-- listing_goals(date, employee), which is the obvious implementation and does not
-- work: that table already holds 84 duplicate (date, employee) pairs — partly the
-- Multi-Store Manager, who legitimately appears at BOTH of his stores on the same
-- day, and partly legacy first-name-only rows ('Zach', 'Garrett') from before
-- names were full. A unique index would refuse to build, and forcing it would
-- break the MSM's dual-store widget.
create table if not exists public.listing_floater_claims (
  date        date not null,
  employee    text not null,
  store       text not null,
  claimed_by  text,
  claimed_at  timestamptz not null default now(),
  primary key (date, employee)
);

comment on table public.listing_floater_claims is
  'One row = a floater is spoken for at one store on one day. PK (date, employee) is the whole mechanic: the insert that wins is the claim, and a losing insert tells the other store who has him.';

create index if not exists listing_floater_claims_store_date
  on public.listing_floater_claims (store, date);

alter table public.listing_floater_claims enable row level security;
-- Written only through the store-targets edge function, like listing_goal_weeks.
create policy listing_floater_claims_service_only on public.listing_floater_claims
  for all to service_role using (true) with check (true);
