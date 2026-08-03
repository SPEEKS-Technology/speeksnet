import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================================
// Monthly Breakdown (Performance Brief) — values + the row catalog.
//
// NOTE ON THIS FILE'S HISTORY: v1 of this function was deployed without ever
// being committed, so the repo had no copy of it. This file is that deployed
// source plus the catalog work below; don't treat the older sections as new.
//
// Values live in `monthly_brief`, which is entity-attribute-value:
//   (store, period_end_date, metric_key, value)
// so a new row on the page is just a new metric_key — no schema change.
//
// The CATALOG (which rows exist, their label, type, section, order and grading
// behaviour) used to be the hardcoded METRICS array below. It now lives in
// `monthly_brief_metrics` so a DM or CEO can add rows from the Manage Rows
// editor with no deploy. The array survives only as a cold-start fallback.
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-pin',
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

type Metric = {
  key: string; label: string; type: string; section: string;
  sort_order?: number; lower_is_better?: boolean; no_shade?: boolean;
  source?: string; formula_key?: string | null; formula_arg?: string | null;
};

// Fallback catalog. Used ONLY if the catalog table is unreachable or empty —
// otherwise a transient DB error would blank the entire Monthly Breakdown for
// every user rather than degrading to the rows we shipped with. Kept in the
// original order; the seed in migration 0011 mirrors it exactly.
const FALLBACK_METRICS: Metric[] = [
  { key: 'buying',                  label: 'Buying',                      type: 'money',  section: 'Buying & Customers' },
  { key: 'buying_gm',               label: 'Buying GM',                   type: 'pct',    section: 'Buying & Customers' },
  { key: 'buy_vs_sell_variance',    label: 'Buy vs Sell Variance',        type: 'pct',    section: 'Buying & Customers' },
  { key: 'customer_close_rate',     label: 'Customer Close Rate',         type: 'pct',    section: 'Buying & Customers' },
  { key: 'device_close_rate',       label: 'Device Close Rate',           type: 'pct',    section: 'Buying & Customers' },
  { key: 'num_customers',           label: '# of Customers',              type: 'int',    section: 'Buying & Customers' },
  { key: 'buy_value_per_customer',  label: 'Buy Value/Customer',          type: 'money',  section: 'Buying & Customers' },
  { key: 'num_items_purchased',     label: '# of Items Purchased',        type: 'int',    section: 'Buying & Customers' },
  { key: 'returning_customers',     label: 'Returning Customers',         type: 'int',    section: 'Buying & Customers' },
  { key: 'pct_returning_customers', label: '% of Returning Customers',    type: 'pct',    section: 'Buying & Customers' },
  { key: 'avg_transaction_time',    label: 'Avg Transaction Time',        type: 'num',    section: 'Buying & Customers' },
  { key: 'inventory_cost',          label: 'Inventory Cost',              type: 'money',  section: 'Inventory' },
  { key: 'inventory_cost_under_30', label: 'Inventory Cost <30',          type: 'money',  section: 'Inventory' },
  { key: 'pct_inventory_over_30',   label: '% of Inventory Over 30 days', type: 'pct',    section: 'Inventory' },
  { key: 'recycled_inventory',      label: 'Recycled Inventory',          type: 'money',  section: 'Inventory' },
  { key: 'recycled_pct_inventory',  label: 'Recycled % of Inventory',     type: 'pct',    section: 'Inventory' },
  { key: 'inventory_confiscation',  label: 'Inventory Confiscation',      type: 'money',  section: 'Inventory' },
  { key: 'gross_sales',             label: 'Gross Sales',                 type: 'money',  section: 'Sales & Profit' },
  { key: 'discounts',               label: 'Discounts',                   type: 'money',  section: 'Sales & Profit' },
  { key: 'refunds',                 label: 'Refunds',                     type: 'money',  section: 'Sales & Profit' },
  { key: 'returns_cancelled',       label: 'Returns Cancelled',           type: 'money',  section: 'Sales & Profit' },
  { key: 'return_rate',             label: 'Return Rate',                 type: 'pct',    section: 'Sales & Profit' },
  { key: 'net_sales',               label: 'NET Sales',                   type: 'money',  section: 'Sales & Profit' },
  { key: 'cogs',                    label: 'COGS',                        type: 'money',  section: 'Sales & Profit' },
  { key: 'gross_profit',            label: 'Gross Profit',                type: 'money',  section: 'Sales & Profit' },
  { key: 'gross_profit_pct',        label: 'Gross Profit %',              type: 'pct',    section: 'Sales & Profit' },
  { key: 'cogs_sold_vs_listed',     label: 'COGS sold vs. COGS Listed',   type: 'pct',    section: 'Sales & Profit' },
  { key: 'sales_at_pos',            label: 'Sales at POS',                type: 'money',  section: 'Sales & Profit' },
  { key: 'pct_sales_at_pos',        label: '% of sales at POS',           type: 'pct',    section: 'Sales & Profit' },
  { key: 'sales_online',            label: 'Sales Online',                type: 'money',  section: 'Sales & Profit' },
  { key: 'pct_sales_online',        label: '% of sales Online',           type: 'pct',    section: 'Sales & Profit' },
  { key: 'sale_draft_order',        label: 'Sale Draft Order',            type: 'money',  section: 'Sales & Profit' },
  { key: 'pct_sales_draft_order',   label: '% of sales Draft Order',      type: 'pct',    section: 'Sales & Profit' },
  { key: 'pct_non_ebay_sales',      label: '% of Non eBay sales',         type: 'pct',    section: 'Sales & Profit' },
  { key: 'shipping_label_cost',     label: 'Shipping Label Cost',         type: 'money',  section: 'Sales & Profit' },
  { key: 'shipping_cost_pct_sales', label: 'Shipping cost % of Sales',    type: 'pct',    section: 'Sales & Profit' },
  { key: 'paymore_ranking',         label: 'PayMore Ranking',             type: 'int',    section: 'Rankings & Reviews' },
  { key: 'google_score',            label: 'Google Score',                type: 'rating', section: 'Rankings & Reviews' },
  { key: 'google_reviews',          label: 'Google Reviews',              type: 'int',    section: 'Rankings & Reviews' },
  { key: 'defect_rate',             label: 'Defect Rate (<.5%)',          type: 'pct',    section: 'eBay Health' },
  { key: 'late_shipment_rate',      label: 'Late Shipment Rate (<3%)',    type: 'pct',    section: 'eBay Health' },
  { key: 'case_no_resolution',      label: 'Case w/ No Resolution (<.3%)',type: 'pct',    section: 'eBay Health' },
  { key: 'tracking_uploaded',       label: 'Tracking Uploaded (>95%)',    type: 'pct',    section: 'eBay Health' },
];

// Formula names speeks.js knows how to evaluate. Anything else would render as a
// permanently blank row, so the editor can't save one. Must stay in step with
// _MB_FORMULAS in speeks.js — this list is what the editor offers.
//   legacy    — the existing _MB_DERIVED spreadsheet formulas (no argument)
//   yoy_pct   — % change vs the same month a year earlier
//   yoy_delta — absolute change vs the same month a year earlier, same unit
//   yoy_prior — the same month last year, unchanged
// All three yoy_* take formula_arg: the metric_key they read. One formula each,
// unlimited rows built on them.
const KNOWN_FORMULAS = new Set(['legacy', 'yoy_pct', 'yoy_delta', 'yoy_prior']);

async function loadCatalog(supabase: any): Promise<Metric[]> {
  const { data, error } = await supabase
    .from('monthly_brief_metrics')
    .select('metric_key, label, type, section, sort_order, lower_is_better, no_shade, source, formula_key, formula_arg')
    .eq('active', true)
    .order('sort_order').order('metric_key');
  if (error || !data || !data.length) return FALLBACK_METRICS;
  return data.map((r: any) => ({
    key: r.metric_key, label: r.label, type: r.type, section: r.section,
    sort_order: r.sort_order,
    lower_is_better: !!r.lower_is_better,
    no_shade: !!r.no_shade,
    source: r.source, formula_key: r.formula_key, formula_arg: r.formula_arg,
  }));
}

// A month becomes editable on its last day and locks when the NEXT month's last day arrives.
function getEditableMonthEnd(): string {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const curEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  if (today >= curEnd) return curEnd.toISOString().slice(0, 10);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

function canEditBrief(role: string): boolean {
  return (role || '').toLowerCase().trim() === 'district manager';
}

// Who may change the SHAPE of the brief. Wider than canEditBrief (which is
// DM-only for the numbers) because the CEO owns what the report contains, but
// still corp-only — a store manager can't add a row to every store's report.
function canManageCatalog(role: string): boolean {
  const r = (role || '').toLowerCase().trim();
  return r === 'district manager' || r === 'ceo' || r === 'owner manager' || r === 'owner (manager)';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const url   = new URL(req.url);
  const store = (url.searchParams.get('store') || '').toUpperCase();

  // ── GET ───────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const metrics = await loadCatalog(supabase);

    // ?catalog=1 — the Manage Rows editor needs EVERY row including hidden
    // ones, so it can show and un-hide them. The brief itself only ever wants
    // the active list, which is the default response below.
    if (url.searchParams.get('catalog') === '1') {
      const { data: all } = await supabase
        .from('monthly_brief_metrics').select('*')
        .order('sort_order').order('metric_key');
      // How many stored values each key carries. A COUNT, not just a flag: a
      // hard delete has to be able to say "this destroys 115 values across every
      // store" rather than a vague "this row has data".
      const { data: used } = await supabase
        .from('monthly_brief').select('metric_key').not('value', 'is', null);
      const counts: Record<string, number> = {};
      (used || []).forEach((r: any) => { counts[r.metric_key] = (counts[r.metric_key] || 0) + 1; });
      return json({
        catalog: all || [],
        in_use: Object.keys(counts),   // kept for anything reading the older shape
        in_use_counts: counts,
        formulas: [...KNOWN_FORMULAS],
      });
    }

    if (!store) return json({ error: 'Missing store' }, 400);

    const { data: rows } = await supabase
      .from('monthly_brief').select('period_end_date, metric_key, value')
      .eq('store', store).order('period_end_date');

    const data: Record<string, Record<string, number>> = {};
    (rows || []).forEach((r: any) => {
      if (!data[r.period_end_date]) data[r.period_end_date] = {};
      data[r.period_end_date][r.metric_key] = r.value;
    });

    const editable = getEditableMonthEnd();
    const months = Object.keys(data).sort();
    // Always surface the editable month even if it has no data yet
    if (!months.includes(editable)) { months.push(editable); months.sort(); }

    return json({ store, months, data, editable_period: editable, metrics });
  }

  // ── POST ──────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const pin = req.headers.get('x-user-pin') || '';
    if (!pin) return json({ error: 'Missing x-user-pin header' }, 401);

    const { data: user } = await supabase
      .from('users').select('name, role').eq('pin', pin).single();
    if (!user) return json({ error: 'Invalid PIN' }, 401);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const action = String(body.action || '');

    // ---- catalog management (DM / CEO / owner-manager) --------------------
    // Checked before the numbers path so its own role gate applies rather than
    // canEditBrief, which is DM-only.
    if (action === 'save_metric' || action === 'delete_metric' || action === 'purge_metric'
        || action === 'reorder_metrics' || action === 'rename_section') {
      if (!canManageCatalog(user.role))
        return json({ error: 'Only a District Manager or CEO can change the brief\'s rows' }, 403);

      // A section isn't a record — it's just a value repeated across rows. So
      // renaming and deleting are the SAME write: point every row at a different
      // name. Renaming to a name that already exists merges the two, which is
      // exactly what deleting-with-a-destination means. One action, no second
      // code path that could drift from this one.
      if (action === 'rename_section') {
        const from = String(body.from || '').trim();
        const to   = String(body.to   || '').trim();
        if (!from || !to) return json({ error: 'Both the current and new section name are required.' }, 400);
        if (to.length > 60) return json({ error: 'Section name is too long (max 60 characters).' }, 400);
        if (to === '__new') return json({ error: 'That name is reserved.' }, 400);
        if (from === to) return json({ success: true, moved: 0 });

        const { data: moved, error } = await supabase.from('monthly_brief_metrics')
          .update({ section: to, updated_by: user.name, updated_at: new Date().toISOString() })
          .eq('section', from)
          .select('metric_key');
        if (error) return json({ error: error.message }, 500);
        return json({ success: true, moved: (moved || []).length, from, to });
      }

      if (action === 'reorder_metrics') {
        const order: string[] = Array.isArray(body.order) ? body.order : [];
        if (!order.length) return json({ error: 'No order supplied' }, 400);
        // Rewritten wholesale, spaced by 10, so the result can never contain the
        // duplicate sort_order values that made the seeded Margin Guide rows tie.
        for (let i = 0; i < order.length; i++) {
          const { error } = await supabase.from('monthly_brief_metrics')
            .update({ sort_order: (i + 1) * 10, updated_by: user.name, updated_at: new Date().toISOString() })
            .eq('metric_key', String(order[i]));
          if (error) return json({ error: error.message }, 500);
        }
        return json({ success: true, reordered: order.length });
      }

      const key = String(body.metric_key || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]*$/.test(key))
        return json({ error: 'Key must start with a letter and use only lowercase letters, numbers and underscores.' }, 400);

      if (action === 'delete_metric') {
        // Soft delete (the "Hide" button) — the row leaves the report but its
        // values stay in monthly_brief, so showing it again brings the history
        // back intact. This stays the easy, reversible default.
        const { error } = await supabase.from('monthly_brief_metrics')
          .update({ active: false, updated_by: user.name, updated_at: new Date().toISOString() })
          .eq('metric_key', key);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true, hidden: key });
      }

      // HARD delete: the catalog row AND every value ever stored under its key.
      // Deliberately a separate action from delete_metric rather than a flag on
      // it — the two have opposite consequences, and a flag is exactly the kind
      // of thing that gets passed wrongly.
      if (action === 'purge_metric') {
        const { data: meta } = await supabase.from('monthly_brief_metrics')
          .select('metric_key, source, formula_key').eq('metric_key', key).maybeSingle();
        if (!meta) return json({ error: 'That row no longer exists.' }, 404);

        // The 13 spreadsheet formulas are bound to _MB_DERIVED in speeks.js.
        // Deleting one leaves code computing a row the catalog no longer has.
        if (meta.source === 'derived' && meta.formula_key === 'legacy')
          return json({ error: 'Built-in formula rows can\'t be deleted. Hide it instead.' }, 400);

        // A derived row reads another row by key. Deleting the row it points at
        // would leave it permanently blank with nothing on screen to say why.
        const { data: dependents } = await supabase.from('monthly_brief_metrics')
          .select('label').eq('formula_arg', key);
        if (dependents && dependents.length) {
          return json({
            error: 'Used by ' + dependents.map((d: any) => '“' + d.label + '”').join(', ') +
                   '. Delete or repoint ' + (dependents.length === 1 ? 'that row' : 'those rows') + ' first.',
          }, 409);
        }

        // Values first. If the catalog row went first and this then failed, the
        // values would be stranded with no definition and no way to reach them.
        const { data: killed, error: valErr } = await supabase.from('monthly_brief')
          .delete().eq('metric_key', key).select('id');
        if (valErr) return json({ error: valErr.message }, 500);

        const { error: rowErr } = await supabase.from('monthly_brief_metrics')
          .delete().eq('metric_key', key);
        if (rowErr) return json({ error: rowErr.message }, 500);

        return json({ success: true, deleted: key, values_deleted: (killed || []).length });
      }

      const source = body.source === 'derived' ? 'derived' : 'manual';
      const formulaKey = source === 'derived' ? String(body.formula_key || '').trim() : null;
      if (source === 'derived' && !KNOWN_FORMULAS.has(formulaKey!))
        return json({ error: 'Unknown formula. A derived row must use one the app can evaluate.' }, 400);

      const row = {
        metric_key: key,
        label: String(body.label || '').trim(),
        type: ['money', 'pct', 'int', 'rating', 'num'].includes(body.type) ? body.type : 'num',
        section: String(body.section || 'Other').trim() || 'Other',
        sort_order: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 999,
        active: body.active === false ? false : true,
        lower_is_better: !!body.lower_is_better,
        no_shade: !!body.no_shade,
        source,
        formula_key: formulaKey,
        formula_arg: source === 'derived' ? (String(body.formula_arg || '').trim() || null) : null,
        updated_by: user.name,
        updated_at: new Date().toISOString(),
      };
      if (!row.label) return json({ error: 'Label is required.' }, 400);

      // Every yoy_* formula reads another row, so that row has to exist — and it
      // can't be itself, which would compare a value with its own past and drift
      // into nonsense (yoy_pct would sit at a constant 0%).
      if (String(row.formula_key || '').startsWith('yoy_')) {
        if (!row.formula_arg) return json({ error: 'Choose which metric this compares year over year.' }, 400);
        if (row.formula_arg === row.metric_key) return json({ error: 'A YoY row cannot compare against itself.' }, 400);
        const { data: src } = await supabase.from('monthly_brief_metrics')
          .select('metric_key').eq('metric_key', row.formula_arg).maybeSingle();
        if (!src) return json({ error: 'The metric this compares against does not exist.' }, 400);
      }

      const { data: saved, error } = await supabase
        .from('monthly_brief_metrics').upsert(row, { onConflict: 'metric_key' })
        .select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, metric: saved });
    }

    // ---- the numbers (unchanged: DM only) ---------------------------------
    if (!canEditBrief(user.role)) return json({ error: 'Only the District Manager can edit the brief' }, 403);

    const { store: bStore, period_end_date, values } = body;
    const storeUpper = (bStore || '').toUpperCase();
    if (!storeUpper || !period_end_date || typeof values !== 'object')
      return json({ error: 'Missing required fields' }, 400);

    if (period_end_date !== getEditableMonthEnd())
      return json({ error: 'Period is locked — only the current month is editable' }, 403);

    // Writable keys now come from the catalog rather than a const, and DERIVED
    // rows are excluded: a computed value must never be settable by a form post,
    // or a stale page could freeze a number that should be recalculating.
    const catalog = await loadCatalog(supabase);
    const writable = new Set(catalog.filter(m => m.source !== 'derived' || m.formula_key === 'legacy').map(m => m.key));

    const pDate = new Date(period_end_date + 'T00:00:00Z');
    const rows = Object.keys(values)
      .filter(k => writable.has(k))
      .map(k => ({
        store: storeUpper,
        period_end_date,
        month: pDate.getUTCMonth() + 1,
        year: pDate.getUTCFullYear(),
        metric_key: k,
        value: (values[k] === '' || values[k] === null || values[k] === undefined || isNaN(Number(values[k]))) ? null : Number(values[k]),
        updated_by: user.name || pin,
        updated_at: new Date().toISOString(),
      }));

    if (!rows.length) return json({ error: 'No valid metrics provided' }, 400);

    const { error } = await supabase
      .from('monthly_brief')
      .upsert(rows, { onConflict: 'store,period_end_date,metric_key' });
    if (error) return json({ error: error.message }, 500);

    return json({ success: true, saved: rows.length });
  }

  return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
});
