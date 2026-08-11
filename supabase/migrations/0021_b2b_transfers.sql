-- ============================================================================
-- Move a deal between stores mid-flight, and record who moved it.
--
-- A pickup gets routed to a store that turns out to be swamped, or the wrong one
-- was picked. Until now the only way out was to decline and start again, which
-- loses the pricing.
--
-- The audit table is the point. Changing pricing_store or listing_store is one
-- UPDATE; what matters afterwards is being able to answer "why is this pallet at
-- MPL when the paperwork says LEE" -- and a deal row only ever holds where it is
-- NOW. Physical goods moving between buildings is exactly the kind of thing
-- someone asks about a month later.
--
-- Deliberately its own table rather than columns on b2b_deals: a deal can be
-- moved more than once, and the second move must not erase the first.
--
-- Applied via Supabase MCP `apply_migration`.
-- ============================================================================

create table if not exists public.b2b_deal_transfers (
  id         uuid primary key default gen_random_uuid(),
  deal_id    uuid not null references public.b2b_deals(id) on delete cascade,
  -- Which hand-off moved: the store that prices it, or the store that lists it.
  kind       text not null check (kind in ('pricing', 'listing')),
  from_store text,
  to_store   text not null,
  moved_by   text,
  note       text check (length(coalesce(note, '')) <= 1000),
  created_at timestamptz not null default now()
);

create index if not exists b2b_deal_transfers_deal_idx
  on public.b2b_deal_transfers (deal_id, created_at desc);

-- Same posture as every other B2B table: RLS on, no policies, reachable only
-- through the service-role edge function.
alter table public.b2b_deal_transfers enable row level security;
