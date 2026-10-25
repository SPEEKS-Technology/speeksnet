-- 0158 — QuickPortal layouts saved to the PERSON, not the browser.
--
-- Ethan, 2026-10-25. A Customize layout lived only in localStorage
-- (speeksQpLayout_<name>): it did not follow anyone to another computer, it
-- vanished with the browser's site data or in a private window, and nobody
-- could look at or fix someone else's page. One row per person here, read and
-- written only through the qp-layout edge function (service role).
--
-- WHO is the display name, lower-cased (user_key) — the same free-text
-- identity the rest of the site uses (no user_id exists; see CLAUDE.md). A
-- renamed person starts from the default again, as they would have before.
--
-- rows: the layout, exactly as the front end keeps it ([{items, w}]); null =
--   the default page (Reset), kept as a row so `seen` survives a reset.
-- seen: widget ids this person has had in front of them in the Add a Widget
--   drawer — drives the "New" mark on widgets added since (_qpLibSeen).

create table if not exists public.qp_layouts (
    user_key   text primary key,
    user_name  text not null,
    rows       jsonb,
    seen       text[] not null default '{}',
    updated_at timestamptz not null default now()
);

comment on table public.qp_layouts is 'QuickPortal Customize layout per person (display name, lower-cased). Written only by the qp-layout edge function. rows null = default page; seen = widget ids already shown in the Add a Widget drawer (the "New" mark). See 0158.';

-- The house pattern: RLS on, no policy. anon holds full grants on public, so
-- this is the only barrier; the edge function comes in on the service role.
alter table public.qp_layouts enable row level security;
