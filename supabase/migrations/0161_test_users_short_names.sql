-- 0161 — SHORTER TEST ACCOUNT NAMES (Ethan, 2026-10-28: "on the test accounts
-- can you fix the top nav bar from being collapsed").
--
-- The top nav drops its labels to icons whenever the room between the logo and
-- the right-hand buttons is short of what the labels need (NAV COMPACT MODE,
-- speeks.js), and the right-hand side carries "Welcome <name>!". The names from
-- 0160 ran to 22 characters ("Test Owner Manager LEE") against 18 for the
-- longest real name, so a test account's bar collapsed at window widths where a
-- real person's did not. Every name here is 13 characters or fewer — no longer
-- than Ethan's — and the role and store show everywhere else on the page.

update public.test_users set name = v.name
from (values
    ('0000', 'Test CEO'),
    ('0001', 'Test DM'),
    ('0002', 'Test MOCD'),
    ('0003', 'Test Manager'),
    ('0004', 'Test Owner'),
    ('0005', 'Test MSM'),
    ('0006', 'Test ASM'),
    ('0007', 'Test Employee'),
    ('0008', 'Test Store')
) as v(pin, name)
where public.test_users.pin = v.pin;
