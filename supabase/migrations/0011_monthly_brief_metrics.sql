-- ============================================================================
-- The Monthly Breakdown's row catalog, moved out of code and into the database.
--
-- Adding a row used to mean editing TWO files and redeploying twice: the
-- METRICS array in the monthly-brief edge function, and a pair of Sets in
-- speeks.js. This makes the catalog data, so a DM or CEO can add a row from the
-- Manage Rows editor with no deploy at all.
--
-- The values themselves need no migration. `monthly_brief` is already
-- entity-attribute-value — (store, period_end_date, metric_key, value) — so a
-- new row is just a new metric_key. Nothing is backfilled or moved below.
--
-- WHY THE BEHAVIOUR FLAGS LIVE HERE TOO
--
-- A metric is more than a label. `lower_is_better` and `no_shade` were Sets in
-- speeks.js (_MB_INVERSE / _MB_NO_SHADE) that decide whether a number is
-- coloured green or red. A catalog carrying only label/type/section would let
-- someone add "Refund Rate" and have it graded BACKWARDS — higher shown as
-- better — with nothing in the UI to explain why. So the flags move with the
-- definition, and the editor exposes them as a plain "lower is better" tick.
--
-- MANUAL VS DERIVED
--
--   source = 'manual'   a number somebody types. Fully data-driven: add, edit
--                       and reorder these with no code change ever.
--   source = 'derived'  computed. formula_key names a function in speeks.js and
--                       formula_arg is what it operates on. Adding a derived row
--                       needs no code change either, PROVIDED it reuses a
--                       formula that already exists — which is the whole point
--                       of yoy_pct: one formula, unlimited YoY rows.
--
-- Derived rows are never writable. The edge function rejects a POST that tries
-- to set one, so a computed column can't be overwritten by a stale form post.
--
-- SOFT DELETE ONLY
--
-- `active = false` retires a row. A hard delete would orphan every historical
-- value stored under that metric_key — the numbers would survive in
-- monthly_brief with nothing left to explain what they meant.
--
-- RLS on with no policies, like every other table here: reads and writes go
-- exclusively through the service-role edge function.
-- ============================================================================

create table if not exists public.monthly_brief_metrics (
  metric_key  text primary key,
  label       text not null,
  -- Drives formatting in _mbFmt: money -> $1,234, pct -> 12.3%, rating -> 4.6 ★,
  -- int -> 1,234, num -> one decimal.
  type        text not null default 'num'
              check (type in ('money', 'pct', 'int', 'rating', 'num')),
  section     text not null default 'Other',
  sort_order  int  not null default 0,
  active      boolean not null default true,

  -- Grading behaviour (was _MB_INVERSE / _MB_NO_SHADE in speeks.js).
  lower_is_better boolean not null default false,
  no_shade        boolean not null default false,

  source      text not null default 'manual' check (source in ('manual', 'derived')),
  formula_key text,
  formula_arg text,

  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- A derived row with no formula would render as a permanently empty,
  -- uneditable line: the one state that looks like a bug and isn't recoverable
  -- from the UI.
  constraint mbm_derived_has_formula check (source <> 'derived' or formula_key is not null),
  -- A manual row with a formula is a contradiction — it would be typed in AND
  -- computed, and which won would depend on save order.
  constraint mbm_manual_has_no_formula check (source <> 'manual' or formula_key is null),
  constraint mbm_len check (
    length(metric_key) between 1 and 60 and
    length(label)      between 1 and 80 and
    length(section)    between 1 and 60
  ),
  -- Keys become element ids (mb-ov-OVL-<key>) and are matched against
  -- monthly_brief.metric_key, so keep them to the shape the existing 43 use.
  constraint mbm_key_shape check (metric_key ~ '^[a-z][a-z0-9_]*$')
);

-- Every read is "the whole active catalog in display order".
create index if not exists monthly_brief_metrics_order_idx
  on public.monthly_brief_metrics (active, sort_order, metric_key);

alter table public.monthly_brief_metrics enable row level security;

comment on table public.monthly_brief_metrics is
  'Row catalog for the Monthly Breakdown. Managed by DM/CEO in the Manage Rows editor. Values live in monthly_brief, keyed by metric_key.';

-- ---------------------------------------------------------------------------
-- Seed: the 43 metrics exactly as they were hardcoded, in their existing order,
-- with the flags they already had in speeks.js.
--
-- sort_order is spaced by 10 so a row can be inserted between two others
-- without renumbering the whole table.
--
-- ON CONFLICT DO NOTHING so re-running this can never overwrite edits made in
-- the UI after the first apply.
-- ---------------------------------------------------------------------------
insert into public.monthly_brief_metrics
  (metric_key, label, type, section, sort_order, lower_is_better, no_shade, source, formula_key, formula_arg)
values
  ('buying',                  'Buying',                      'money',  'Buying & Customers',  10,  false, false, 'manual', null, null),
  ('buying_gm',               'Buying GM',                   'pct',    'Buying & Customers',  20,  false, false, 'manual', null, null),
  ('buy_vs_sell_variance',    'Buy vs Sell Variance',        'pct',    'Buying & Customers',  30,  false, false, 'manual', null, null),
  ('customer_close_rate',     'Customer Close Rate',         'pct',    'Buying & Customers',  40,  false, false, 'manual', null, null),
  ('device_close_rate',       'Device Close Rate',           'pct',    'Buying & Customers',  50,  false, false, 'manual', null, null),
  ('num_customers',           '# of Customers',              'int',    'Buying & Customers',  60,  false, false, 'manual', null, null),
  ('buy_value_per_customer',  'Buy Value/Customer',          'money',  'Buying & Customers',  70,  false, false, 'derived', 'legacy', null),
  ('num_items_purchased',     '# of Items Purchased',        'int',    'Buying & Customers',  80,  false, false, 'manual', null, null),
  ('returning_customers',     'Returning Customers',         'int',    'Buying & Customers',  90,  false, false, 'manual', null, null),
  ('pct_returning_customers', '% of Returning Customers',    'pct',    'Buying & Customers', 100,  false, false, 'derived', 'legacy', null),
  ('avg_transaction_time',    'Avg Transaction Time',        'num',    'Buying & Customers', 110,  true,  false, 'manual', null, null),

  ('inventory_cost',          'Inventory Cost',              'money',  'Inventory',          120,  true,  false, 'manual', null, null),
  ('inventory_cost_under_30', 'Inventory Cost <30',          'money',  'Inventory',          130,  true,  false, 'manual', null, null),
  ('pct_inventory_over_30',   '% of Inventory Over 30 days', 'pct',    'Inventory',          140,  true,  false, 'derived', 'legacy', null),
  ('recycled_inventory',      'Recycled Inventory',          'money',  'Inventory',          150,  true,  false, 'manual', null, null),
  ('recycled_pct_inventory',  'Recycled % of Inventory',     'pct',    'Inventory',          160,  true,  false, 'derived', 'legacy', null),
  ('inventory_confiscation',  'Inventory Confiscation',      'money',  'Inventory',          170,  true,  false, 'manual', null, null),

  ('gross_sales',             'Gross Sales',                 'money',  'Sales & Profit',     180,  false, false, 'manual', null, null),
  ('discounts',               'Discounts',                   'money',  'Sales & Profit',     190,  true,  false, 'manual', null, null),
  ('refunds',                 'Refunds',                     'money',  'Sales & Profit',     200,  true,  false, 'manual', null, null),
  ('returns_cancelled',       'Returns Cancelled',           'money',  'Sales & Profit',     210,  false, false, 'manual', null, null),
  ('return_rate',             'Return Rate',                 'pct',    'Sales & Profit',     220,  true,  false, 'derived', 'legacy', null),
  ('net_sales',               'NET Sales',                   'money',  'Sales & Profit',     230,  false, false, 'manual', null, null),
  ('cogs',                    'COGS',                        'money',  'Sales & Profit',     240,  false, false, 'manual', null, null),
  ('gross_profit',            'Gross Profit',                'money',  'Sales & Profit',     250,  false, false, 'derived', 'legacy', null),
  ('gross_profit_pct',        'Gross Profit %',              'pct',    'Sales & Profit',     260,  false, false, 'derived', 'legacy', null),
  ('cogs_sold_vs_listed',     'COGS sold vs. COGS Listed',   'pct',    'Sales & Profit',     270,  false, false, 'derived', 'legacy', null),
  ('sales_at_pos',            'Sales at POS',                'money',  'Sales & Profit',     280,  false, false, 'manual', null, null),
  ('pct_sales_at_pos',        '% of sales at POS',           'pct',    'Sales & Profit',     290,  false, false, 'derived', 'legacy', null),
  ('sales_online',            'Sales Online',                'money',  'Sales & Profit',     300,  false, false, 'manual', null, null),
  ('pct_sales_online',        '% of sales Online',           'pct',    'Sales & Profit',     310,  false, false, 'derived', 'legacy', null),
  ('sale_draft_order',        'Sale Draft Order',            'money',  'Sales & Profit',     320,  false, false, 'manual', null, null),
  ('pct_sales_draft_order',   '% of sales Draft Order',      'pct',    'Sales & Profit',     330,  false, false, 'derived', 'legacy', null),
  ('pct_non_ebay_sales',      '% of Non eBay sales',         'pct',    'Sales & Profit',     340,  false, false, 'derived', 'legacy', null),
  ('shipping_label_cost',     'Shipping Label Cost',         'money',  'Sales & Profit',     350,  true,  false, 'manual', null, null),
  ('shipping_cost_pct_sales', 'Shipping cost % of Sales',    'pct',    'Sales & Profit',     360,  true,  false, 'derived', 'legacy', null),

  ('paymore_ranking',         'PayMore Ranking',             'int',    'Rankings & Reviews', 370,  true,  true,  'manual', null, null),
  ('google_score',            'Google Score',                'rating', 'Rankings & Reviews', 380,  false, true,  'manual', null, null),
  ('google_reviews',          'Google Reviews',              'int',    'Rankings & Reviews', 390,  false, true,  'manual', null, null),

  ('defect_rate',             'Defect Rate (<.5%)',          'pct',    'eBay Health',        400,  true,  false, 'manual', null, null),
  ('late_shipment_rate',      'Late Shipment Rate (<3%)',    'pct',    'eBay Health',        410,  true,  false, 'manual', null, null),
  ('case_no_resolution',      'Case w/ No Resolution (<.3%)','pct',    'eBay Health',        420,  true,  false, 'manual', null, null),
  ('tracking_uploaded',       'Tracking Uploaded (>95%)',    'pct',    'eBay Health',        430,  false, false, 'manual', null, null)
on conflict (metric_key) do nothing;

-- The 13 rows seeded as source='derived', formula_key='legacy' are the existing
-- _MB_DERIVED spreadsheet formulas. 'legacy' means "computed by the hardcoded
-- _MB_DERIVED table in speeks.js" rather than by the parameterised registry —
-- they take no formula_arg and stay exactly as they were. Marking them derived
-- here is what makes the editor show them as read-only instead of offering an
-- input that would be overwritten on the next save.
