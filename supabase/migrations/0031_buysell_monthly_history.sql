-- Monthly selling and buying totals for months that predate daily_buysell.
-- The day-by-day capture starts at 2026-01, so a year-over-year comparison has
-- nothing to stand on; these rows come from the "Sales Summary 2025" workbook,
-- one row per store per month, and exist only to be compared against.
--
-- MONTH TOTALS ONLY, on purpose. The 2025 workbook keeps daily figures too, but
-- what this feeds is a single "last year" line beside a month total, and
-- importing 365 days per store to render one number would be inventing a second
-- source of truth for days nothing else in the site can see.
--
-- NAMING follows the rest of the buy/sell code, which is the OPPOSITE of the
-- spreadsheet's column headings: `resale` is the resale value of what was
-- bought (the sheet's "Sell") and `paid` is the cash that left the till (the
-- sheet's "Buy").
create table if not exists public.buysell_monthly_history (
    id          bigserial primary key,
    store       text not null,
    ym          text not null check (ym ~ '^\d{4}-\d{2}$'),
    sales       numeric,
    cost        numeric,
    gp          numeric,
    resale      numeric,
    paid        numeric,
    source      text,
    created_at  timestamptz not null default now(),
    unique (store, ym)
);

-- Service role only, like every other table behind the edge functions: the
-- browser never reads this directly.
alter table public.buysell_monthly_history enable row level security;

-- 2025, as the workbook finished it. Every row was checked twice on the way in:
-- revenue - cost = GP against the margin the sheet printed for that store, and
-- the sum of the stores against the workbook's own company row, to the cent.
-- WSP only opened in June 2025; MPL and BAL are 2026 stores and have no rows.
insert into public.buysell_monthly_history (store, ym, sales, cost, gp, resale, paid, source) values
('OVL','2025-01',73350.54,33800.63,39549.91,63035.00,29798.00,'sales-summary-2025'),
('LEE','2025-01',35302.98,15592.09,19710.89,48197.00,22140.00,'sales-summary-2025'),
('OVL','2025-02',80845.20,34828.82,46016.38,58847.00,27448.00,'sales-summary-2025'),
('LEE','2025-02',48500.14,21268.55,27231.59,50224.00,20622.00,'sales-summary-2025'),
('OVL','2025-03',78859.65,34255.45,44604.20,100865.00,50763.00,'sales-summary-2025'),
('LEE','2025-03',58572.74,28508.10,30064.64,62913.00,27009.00,'sales-summary-2025'),
('OVL','2025-04',88166.34,42149.41,46016.93,99563.00,49440.00,'sales-summary-2025'),
('LEE','2025-04',50221.01,22394.91,27826.10,57436.00,24495.00,'sales-summary-2025'),
('OVL','2025-05',109923.94,47028.68,62895.26,112055.00,54947.00,'sales-summary-2025'),
('LEE','2025-05',54412.59,25402.74,29009.85,62152.00,25231.00,'sales-summary-2025'),
('OVL','2025-06',115570.36,61158.22,54412.14,115392.00,55904.00,'sales-summary-2025'),
('LEE','2025-06',43937.87,21279.19,22658.68,52763.00,21895.00,'sales-summary-2025'),
('WSP','2025-06',8700.89,3574.00,5126.89,22182.00,10604.00,'sales-summary-2025'),
('OVL','2025-07',132120.44,64853.10,67267.34,127217.00,61012.00,'sales-summary-2025'),
('LEE','2025-07',55144.21,26822.42,28321.79,61049.00,28269.00,'sales-summary-2025'),
('WSP','2025-07',49968.06,21021.04,28947.02,79663.00,40876.00,'sales-summary-2025'),
('OVL','2025-08',105622.08,52032.61,53589.47,137545.00,63741.00,'sales-summary-2025'),
('LEE','2025-08',52224.24,25316.09,26908.15,70094.00,32617.00,'sales-summary-2025'),
('WSP','2025-08',61892.07,31007.06,30885.01,82869.00,39156.00,'sales-summary-2025'),
('OVL','2025-09',92304.08,41141.25,51162.83,76437.00,35470.00,'sales-summary-2025'),
('LEE','2025-09',72414.06,35891.80,36522.26,66804.00,30590.00,'sales-summary-2025'),
('WSP','2025-09',69307.11,33923.17,35383.94,95155.00,44076.00,'sales-summary-2025'),
('OVL','2025-10',112487.46,48620.90,63866.56,103504.00,43723.00,'sales-summary-2025'),
('LEE','2025-10',69750.14,32818.97,36931.17,93796.00,33464.00,'sales-summary-2025'),
('WSP','2025-10',81737.06,38321.14,43415.92,75296.00,34039.00,'sales-summary-2025'),
('OVL','2025-11',108405.81,42669.31,65736.50,97323.00,45996.00,'sales-summary-2025'),
('LEE','2025-11',83665.17,32627.12,51038.05,68168.00,29049.00,'sales-summary-2025'),
('WSP','2025-11',89628.63,43210.60,46418.03,66111.00,28830.00,'sales-summary-2025'),
('OVL','2025-12',131765.92,55943.67,75822.25,102729.00,50247.00,'sales-summary-2025'),
('LEE','2025-12',75034.04,34782.19,40251.85,64579.00,31057.00,'sales-summary-2025'),
('WSP','2025-12',77261.43,33755.69,43505.74,88883.00,39661.00,'sales-summary-2025')
on conflict (store, ym) do update set
    sales = excluded.sales, cost = excluded.cost, gp = excluded.gp,
    resale = excluded.resale, paid = excluded.paid, source = excluded.source;
