-- 0160 — TEST ACCOUNTS, ONE A ROLE (Ethan, 2026-10-28: "create each role with
-- a test account with pins starting from 0000", for "pure testing new designs
-- and stuff", on the live site too, filled with dummy data).
--
-- A TABLE OF THEIR OWN, NOT ROWS IN users. Eighteen edge functions read users
-- (store-targets sizes each store's listing goal from it, kpi-manage builds the
-- KPI roster, usage-report flags whoever never signed in, notify nudges
-- managers, the morning emails pick recipients…). A test row there would move
-- real goals and send real mail unless every one of them learned to skip it.
-- Here, nothing but the auth function ever reads this table, and auth returns
-- these accounts in a separate `test_users` list, so even the browser-side
-- rosters that read the users list never see them. Only the PIN check does.
--
-- What a test account can do is limited in the browser, not here: signing in
-- with one starts a TEST SESSION (TEST SESSION, top of speeks.js) that refuses
-- every save and draws sample data. So there is no write path to guard.
--
-- PINs 0000-0008. No real account had a PIN in 0000-0019 on 2026-10-28. The
-- auth POST refuses to give a real person one of these.
--
-- RLS on with no policy: the house pattern (anon has table grants; only the
-- service role, i.e. the auth function, reads it). Not granted to ai_reader.

create table if not exists public.test_users (
    pin        text primary key,
    name       text not null,
    role       text not null,
    store      text not null,
    created_at timestamptz not null default now()
);
alter table public.test_users enable row level security;

insert into public.test_users (pin, name, role, store) values
    ('0000', 'Test CEO',                  'ceo',                 'CORP'),
    ('0001', 'Test DM',                   'district manager',    'CORP'),
    ('0002', 'Test MOCD',                 'mocd',                'CORP'),
    ('0003', 'Test Manager OVL',          'manager',             'OVL'),
    ('0004', 'Test Owner Manager LEE',    'owner (manager)',     'LEE'),
    ('0005', 'Test MSM BAL MPL',          'multi-store manager', 'BAL'),
    ('0006', 'Test ASM WSP',              'assistant manager',   'WSP'),
    ('0007', 'Test Employee OVL',         'employee',            'OVL'),
    ('0008', 'Test Store OVL',            'store',               'OVL')
on conflict (pin) do nothing;
