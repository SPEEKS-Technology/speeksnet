-- Expense Report — "I have filed this month" marker.
--
-- The report is sent with a mailto: handed to the person's own mail client, so
-- the app never observes it being sent. There is therefore no way to derive
-- "filed" from the data the way the KPI reminders derive "entered" — it has to
-- be asserted by the person. This table is that assertion.
--
-- Stored server-side rather than in localStorage on purpose: someone may file
-- from a different machine, and a browser-local flag would re-nag them there and
-- give leadership no way to see who has actually filed.
create table if not exists expense_submissions (
    person      text        not null,
    month_start date        not null,
    filed_at    timestamptz not null default now(),
    filed_by    text,
    primary key (person, month_start)
);

-- Same posture as every other table here: RLS on with no policies, so the only
-- way in is the service-role edge function.
alter table expense_submissions enable row level security;

create index if not exists expense_submissions_month_idx
    on expense_submissions (month_start);
