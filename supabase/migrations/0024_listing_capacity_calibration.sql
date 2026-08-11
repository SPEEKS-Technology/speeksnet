-- Applied 2026-08-10. Calibrating 0018 against the real roster and six weeks of
-- real output (weekly kpi_entries, period_end_date 2026-07-05 .. 2026-08-09).

-- ---------------------------------------------------------------------------
-- Who is actually part-time
-- ---------------------------------------------------------------------------
-- Everyone defaulted to full_time in 0018, and a part-timer is half the hours,
-- so this moves capacity more than any constant below.
--
-- Joseph Ortega is the Multi-Store Manager for MPL + BAL. He is one users row
-- with one store, but his week is split between the two, so he is modelled as
-- part-time at EACH of them: 20h + 20h = his real 40. This is what retires the
-- old MSM special case — the ladder excluded him from headcount and handed each
-- of his stores a flat +15. A capacity model needs no special case; he is a
-- person with hours, split, exactly like a floater.
update public.users set employment_type = 'part_time'
  where name in ('Drew Nyman', 'Joseph Ortega');

-- Bret Daubert is in week 2 of the new-hire ramp as of the week of 2026-08-09,
-- so the ramp expires on its own after 2026-08-17. Backdated to the Monday of
-- his first week; correct it if his real start differs.
update public.users set hire_date = date '2026-08-03'
  where name = 'Bret Daubert';

-- ---------------------------------------------------------------------------
-- Constants
-- ---------------------------------------------------------------------------
insert into public.listing_config (key, value, note) values
  ('hours_floater', 25,
    'Scheduled hours/week for a can_float employee. Deliberately neither full- nor part-time: a floater is guaranteed this minimum and lands wherever the market needs help that day.'),
  ('open_days', 6,
    'Store is open Mon-Sat.'),
  ('hours_per_day', 8,
    'Clock hours in one shift. weekly hours / this = days present.'),
  ('saturday_factor', 0.5,
    'A Saturday shift produces about half a weekday shift of listings: shorter day and the busiest buy day of the week. Carried over from the old engine, where it was calibrated against real daily goals.')
on conflict (key) do update set value = excluded.value, note = excluded.note;

-- ⚠️ Turned OFF. The spec deducted measured customer hours from Buyer 1's hours.
-- It double-counts: rate_buyer_1 = 0.5/hr is already a NET rate for someone
-- holding the counter. If customer time were the only drag, an 18h weekly
-- customer load against 48 counter hours would still leave 30h at the 3.0 lister
-- rate — 90 items, not 24. The two corrections describe the same thing.
-- Kept as a key, not deleted: set it to 1 if the rates are ever re-derived as
-- raw uninterrupted rates, at which point the deduction stops being a duplicate.
update public.listing_config set value = 0, note =
  'OFF — double-counts against rate_buyer_1, which is already a net interrupted rate. See migration 0019.'
  where key = 'customer_time_source';

-- ---------------------------------------------------------------------------
-- What the model produces, recorded so a later change can be compared to it
-- ---------------------------------------------------------------------------
--  store  hours/wk                        capacity  goal@0.75  6wk actual  old target
--  WSP    160  (4 FT)                        242       182        133         190
--  OVL    145  (3 FT + floater 25)           201       151        129         190
--  LEE    140  (3 FT + Drew PT)              187       140        182         190
--  MPL    140  (3 FT + Joseph 20)            187       140        184         185
--  BAL    140  (3 FT + Joseph 20, ramping)   164       123        138         185
--
-- Two things to know before trusting these:
--
-- 1. Every capacity goal lands BELOW the flat 190/185 that was in store_targets,
--    which is consistent with no store sustainably hitting it.
--
-- 2. Modelled capacity and actual output point in OPPOSITE directions. WSP has
--    the most hours of any store and nearly the lowest output; MPL has among the
--    fewest and the highest. LEE and MPL run at ~97% of their modelled ceiling,
--    WSP and OVL at 55-64%. So the model prices staffing, not habit — which is
--    the point — but the first live week hands the two best-listing stores an
--    easier number and the two weakest a harder one.
--
-- Caveat on the actuals: some weeks have five people filing KPIs at a
-- three-person store, so historical listed_count includes people who have since
-- left. The averages are directionally right, not exact.
