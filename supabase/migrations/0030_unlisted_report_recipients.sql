-- Put the Monday Unlisted Inventory Weekly Update on the Email Recipients tool.
--
-- The report used to have its recipient hardcoded in the edge function, which
-- meant changing who gets it was a code deploy. It now reads `unlisted_report`
-- from this table, with the hardcoded address kept only as the floor for an
-- empty list — a report that quietly sends to nobody is worse than one that
-- keeps going to the DM.
--
-- Seeded with the address it was already sending to, so the cutover changes
-- nothing about who receives it.

insert into public.email_recipients (list_key, email)
values ('unlisted_report', 'ethan.kushnir@speekstechnology.com')
on conflict (list_key, email) do nothing;
