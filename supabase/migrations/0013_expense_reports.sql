-- Expense Report tracker (DM / MSM submit, CEO reviews).
--
-- One report per person per month, holding two kinds of line: ordinary expenses
-- and mileage. Mileage is stored with the reimbursement rate that was in force
-- when the line was entered, so raising the rate never silently restates a month
-- that has already been filed.

create table if not exists public.expense_categories (
    id         uuid primary key default gen_random_uuid(),
    name       text        not null,
    sort_order integer     not null default 0,
    -- Retired rather than deleted when a category is still referenced by history.
    active     boolean     not null default true,
    created_at timestamptz not null default now()
);
create unique index if not exists expense_categories_name_idx
    on public.expense_categories (lower(name));

-- Small key/value bag. Only holds the current mileage rate today; kept generic so
-- a second setting doesn't need another table.
create table if not exists public.expense_settings (
    key        text        primary key,
    value      text        not null,
    updated_by text,
    updated_at timestamptz not null default now()
);

create table if not exists public.expense_entries (
    id          uuid        primary key default gen_random_uuid(),
    -- Whose report this line belongs to. Not the same as created_by: the CEO can
    -- view anyone's, and we still want to know who typed it.
    person      text        not null,
    month_start date        not null,
    kind        text        not null check (kind in ('expense', 'mileage')),
    entry_date  date        not null,
    category    text,                       -- expenses only
    description text,
    -- Dollars. For mileage this is miles * rate, computed and stored so the
    -- filed total can never drift from what was reported.
    amount      numeric(10,2) not null default 0 check (amount >= -100000 and amount <= 1000000),
    miles       numeric(10,1) check (miles >= 0 and miles <= 100000),
    rate        numeric(6,3) check (rate >= 0 and rate <= 100),
    from_loc    text,
    to_loc      text,
    created_by  text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists expense_entries_person_month_idx
    on public.expense_entries (person, month_start desc);
create index if not exists expense_entries_month_idx
    on public.expense_entries (month_start desc);

-- Service-role only, like every other table here: RLS on with no policies, so all
-- reads and writes go through the expenses edge function.
alter table public.expense_categories enable row level security;
alter table public.expense_settings   enable row level security;
alter table public.expense_entries    enable row level security;

insert into public.expense_categories (name, sort_order) values
    ('Fuel',                     10),
    ('Meals & Entertainment',    20),
    ('Travel & Lodging',         30),
    ('Office Supplies',          40),
    ('Equipment',                50),
    ('Software & Subscriptions', 60),
    ('Repairs & Maintenance',    70),
    ('Other',                    80)
on conflict do nothing;

-- Placeholder until the CEO sets the real figure in the tool.
insert into public.expense_settings (key, value) values ('mileage_rate', '0.70')
on conflict (key) do nothing;

-- Where a submitted report is emailed. Managed in the existing Email Recipients
-- tool alongside the recycle report and weekly reports.
insert into public.email_recipients (list_key, email)
    values ('expense_report', 'paul.kushnir@pikinvestments.com')
on conflict (list_key, email) do nothing;
