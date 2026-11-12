-- 0178 — Returned But Not Back In Stock: a copy for each store's manager.
--
-- Ethan, 2026-11-06: the WSP manager said three open lines were done; Shopify
-- still had all three at 0 on hand. The 7:35am mail only ever went to the DM,
-- so the people who have to restock never saw the list themselves. From today
-- unrestocked-returns also sends each store the same mail cut to its own lines,
-- on mornings that store has anything open, to unrestocked_returns_<STORE>.
--
-- Seeded from the store's Claims & Disputes list (its manager), minus Ethan's
-- own address: he already gets every line on the DM copy (unrestocked_returns).
-- An empty list means that store gets no copy — there is no fallback. Edit in
-- Settings → Email Recipients. Data only; no schema change.

insert into public.email_recipients (list_key, email)
select 'unrestocked_returns_' || substr(list_key, length('claims_disputes_') + 1), email
from public.email_recipients
where list_key in ('claims_disputes_OVL', 'claims_disputes_LEE', 'claims_disputes_WSP',
                   'claims_disputes_MPL', 'claims_disputes_BAL')
  and lower(email) <> 'ethan.kushnir@speekstechnology.com'
on conflict (list_key, email) do nothing;
