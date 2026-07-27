import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-pin',
};

const MONTH_NAMES  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FULL_MONTHS  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Stores overseen by a Multi-Store Manager. Mirrors MULTISTORE_MANAGER_STORES in speeks.js.
// A Multi-Store Manager's DB `store` is only their default home store, so the home-store
// check used for plain managers can't authorize their other store — gate on this list instead.
const MULTISTORE_MANAGER_STORES = ['BAL', 'MPL'];

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

// Realtime "broadcast-as-ping": after a KPI save lands, tell every open client
// so their action-feed re-runs checkKpiDueReminders() and the "KPIs due" nag
// clears the instant the numbers are entered. Only a tiny {tool, store} ping
// travels — no table data — matching every other tool's broadcastChange.
// Wrapped so a broadcast failure can never break the write it follows.
async function broadcastChange(tool: string, store: string | null) {
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{
          topic: 'speeks-notify',
          event: 'changed',
          payload: { tool, store: store ? String(store).toUpperCase() : null, ts: Date.now() },
        }],
      }),
    });
  } catch (_) {
    // swallow — the write already succeeded; realtime is best-effort
  }
}

function formatLabel(type: string, date: string): string {
  const d = new Date(date + 'T00:00:00');
  return type === 'weekly'
    ? `Week ending ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
    : `${FULL_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Returns the "active" Sunday date string.
// New week activates Saturday at 19:00 UTC (adjust ACTIVATION_HOUR_UTC if needed).
const ACTIVATION_HOUR_UTC = 19;

function getActiveSunday(): string {
  const now = new Date();
  const day  = now.getUTCDay();
  const hour = now.getUTCHours();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Saturday at or after activation hour => upcoming Sunday is active
  if (day === 6 && hour >= ACTIVATION_HOUR_UTC) {
    base.setUTCDate(base.getUTCDate() + 1);
  } else {
    // Roll back to most recent past Sunday (or today if Sunday)
    base.setUTCDate(base.getUTCDate() - day);
  }
  return base.toISOString().slice(0, 10);
}

// Returns last N active Sundays (most recent first), starting from the active Sunday.
function getRecentSundays(count: number): string[] {
  const activeSun = new Date(getActiveSunday() + 'T00:00:00Z');
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    results.push(activeSun.toISOString().slice(0, 10));
    activeSun.setUTCDate(activeSun.getUTCDate() - 7);
  }
  return results;
}

// Returns the current editable month-end date string.
// A month becomes editable on its last day and locks when the NEXT month's last day arrives.
function getEditableMonthEnd(): string {
  const now  = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const curEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  // If today is the last day of the current month (or later), current month is editable
  if (today >= curEnd) return curEnd.toISOString().slice(0, 10);
  // Otherwise the previous month's last day is the editable end
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

function isEditablePeriod(type: string, date: string): boolean {
  if (type === 'weekly') return date === getActiveSunday();
  return date === getEditableMonthEnd();
}

// Roles allowed to enter KPIs. Must stay in sync with the canEditRole gate in speeks.js
// (the frontend that shows the Edit/Save button). 'assistant manager' and 'multi-store
// manager' are included here; store-level scoping for them is enforced separately below.
function canEnterKPIs(role: string): boolean {
  const r = (role || '').toLowerCase().trim();
  return r === 'manager' || r === 'assistant manager' || r === 'multi-store manager'
    || r.startsWith('owner') || r === 'ceo' || r === 'district manager';
}

function computeFields(entry: any) {
  const bv  = Number(entry.buying_value)          || 0;
  const bc  = Number(entry.buying_cost)           || 0;
  const tc  = Number(entry.transaction_count)     || 0;
  const tco = Number(entry.transaction_converted) || 0;
  const dc  = Number(entry.device_count)          || 0;
  const dco = Number(entry.device_converted)      || 0;
  const ndv = Number(entry.no_deal_value)         || 0;
  const ndc = Number(entry.no_deal_cost)          || 0;
  const lrp = Number(entry.listed_retail_price)   || 0;
  const lc  = Number(entry.listed_cost)           || 0;
  const lsv = Number(entry.listed_sold_value)     || 0;
  const gp  = bv - bc;
  const r2  = (n: number) => Math.round(n * 100) / 100;
  return {
    ...entry,
    estimated_gross_profit:  gp,
    gross_margin_pct:        bv  > 0 ? r2((1 - bc  / bv)  * 100) : null,
    customer_conversion_pct: tc  > 0 ? r2((tco / tc)  * 100)     : null,
    device_conversion_pct:   dc  > 0 ? r2((dco / dc)  * 100)     : null,
    lost_profit:             ndv - ndc,
    no_deal_vs_buying_pct:   gp  > 0 ? r2(((ndv - ndc) / gp) * 100) : null,
    listed_gross_margin_pct: lrp > 0 ? r2((1 - lc  / lrp) * 100)    : null,
    listed_sold_pct:         lrp > 0 ? r2((lsv / lrp) * 100)         : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const url        = new URL(req.url);
  const store      = (url.searchParams.get('store') || '').toUpperCase();
  const periodType = url.searchParams.get('period_type') || 'weekly';

  // GET
  if (req.method === 'GET') {
    if (!store) return json({ error: 'Missing store' }, 400);

    // ── CSV date-range export modes ──────────────────────────────────────
    // The default response below is deliberately windowed (weekly = the 4 most
    // recent Sundays) because it drives the editable grid. The exporter needs
    // the full history instead, so these two modes read SAVED rows only — no
    // roster synthesis, no window:
    //   ?mode=available            → every period that actually has data
    //   ?mode=range&from=&to=      → the entries inside a chosen span
    // Both are additive; omitting `mode` leaves the grid path untouched.
    const mode = url.searchParams.get('mode') || '';
    if (mode === 'available' || mode === 'range') {
      const from = url.searchParams.get('from') || '';
      const to   = url.searchParams.get('to')   || '';

      let q = supabase
        .from('kpi_entries')
        .select(mode === 'available' ? 'period_end_date' : '*')
        .eq('store', store).eq('period_type', periodType);
      if (from) q = q.gte('period_end_date', from);
      if (to)   q = q.lte('period_end_date', to);

      const { data: rows, error } = await q.order('period_end_date', { ascending: false });
      if (error) return json({ error: error.message }, 500);

      if (mode === 'available') {
        const counts: Record<string, number> = {};
        (rows || []).forEach((r: any) => {
          counts[r.period_end_date] = (counts[r.period_end_date] || 0) + 1;
        });
        return json({
          periods: Object.keys(counts).sort().reverse().map(date => ({
            period_end_date: date,
            period_label:    formatLabel(periodType, date),
            saved_count:     counts[date],
          })),
        });
      }

      const grouped: Record<string, any[]> = {};
      (rows || []).forEach((e: any) => {
        if (!grouped[e.period_end_date]) grouped[e.period_end_date] = [];
        grouped[e.period_end_date].push(e);
      });
      return json({
        periods: Object.keys(grouped).sort().reverse().map(date => ({
          period_end_date: date,
          period_label:    formatLabel(periodType, date),
          is_editable:     isEditablePeriod(periodType, date),
          saved_count:     grouped[date].length,
          entries: grouped[date]
            .sort((a: any, b: any) => String(a.employee_name).localeCompare(String(b.employee_name)))
            .map((e: any) => computeFields(e)),
        })),
      });
    }

    const { data: homeUsers } = await supabase
      .from('users').select('name, role').eq('store', store).order('name');
    const roster = homeUsers || [];

    // A Multi-Store Manager's DB `store` is only their home store, but they belong to
    // every store in MULTISTORE_MANAGER_STORES — include them on each of those stores'
    // rosters so their KPI stats show up on both (e.g. Joseph on BAL *and* MPL).
    if (MULTISTORE_MANAGER_STORES.includes(store)) {
      const { data: msms } = await supabase
        .from('users').select('name, role').ilike('role', 'multi-store manager');
      const have = new Set(roster.map((u: any) => u.name));
      for (const m of (msms || [])) if (!have.has(m.name)) roster.push(m);
    }

    const EXCLUDE = new Set(['ceo', 'district manager', 'tom']);
    const users = roster.filter((u: any) => !EXCLUDE.has((u.role || '').toLowerCase()));
    const currentEmpNames: string[] = users.map((u: any) => u.name);

    const { data: rawEntries } = await supabase
      .from('kpi_entries').select('*')
      .eq('store', store).eq('period_type', periodType)
      .order('period_end_date', { ascending: false });

    // Group entries by date, then by employee name
    const byDate: Record<string, Record<string, any>> = {};
    (rawEntries || []).forEach((e: any) => {
      if (!byDate[e.period_end_date]) byDate[e.period_end_date] = {};
      byDate[e.period_end_date][e.employee_name] = e;
    });

    let datesToShow: string[];

    if (periodType === 'weekly') {
      // Always the 4 most recent active Sundays (new week visible from Sat 19:00 UTC).
      datesToShow = getRecentSundays(4);
    } else {
      // Monthly: show all months from DB whose end-date <= today,
      // plus the current editable month (even if no data yet).
      const now   = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const todayStr = today.toISOString().slice(0, 10);
      const editableEnd = getEditableMonthEnd();

      const dateSet = new Set(
        Object.keys(byDate).filter(d => d <= todayStr)
      );
      dateSet.add(editableEnd); // always include the current editable month
      datesToShow = [...dateSet].sort().reverse();
    }

    const periods = datesToShow.map(date => {
      const savedNames = Object.keys(byDate[date] || {}).sort();
      const editable = isEditablePeriod(periodType, date);
      // The editable (current) period always shows the full current roster — unioned
      // with anyone already saved — so a current team member (e.g. an MSM who also
      // covers this store) appears to be filled in even when others already have data.
      // Past periods stay a historical snapshot: exactly who had entries.
      const namesForDate = editable
        ? [...new Set([...currentEmpNames, ...savedNames])].sort()
        : (savedNames.length > 0 ? savedNames : currentEmpNames);
      return {
        period_end_date: date,
        period_label:    formatLabel(periodType, date),
        is_editable:     isEditablePeriod(periodType, date),
        // How many employees actually have a SAVED row for this period (raw DB
        // rows, not the synthesized roster). Drives the "KPIs still need filling
        // out" reminder — a period with saved_count 0 is untouched.
        saved_count:     savedNames.length,
        entries: namesForDate.map((name: string) =>
          computeFields(byDate[date]?.[name] || { employee_name: name })
        ),
      };
    });

    return json({ periods });
  }

  // POST
  if (req.method === 'POST') {
    const pin = req.headers.get('x-user-pin') || '';
    if (!pin) return json({ error: 'Missing x-user-pin header' }, 401);

    const { data: user } = await supabase
      .from('users').select('name, role, store').eq('pin', pin).single();
    if (!user) return json({ error: 'Invalid PIN' }, 401);
    if (!canEnterKPIs(user.role)) return json({ error: 'Insufficient role' }, 403);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    const { store, period_type, period_end_date, employee_name, ...fields } = body;
    const storeUpper = (store || '').toUpperCase();
    if (!storeUpper || !period_type || !period_end_date || !employee_name)
      return json({ error: 'Missing required fields' }, 400);

    // Store-level scoping. Global roles (CEO / District Manager / Owner) may submit for
    // any store. A plain Manager or Assistant Manager is limited to their home store. A
    // Multi-Store Manager is limited to the stores they oversee (their DB `store` is only
    // their default home store, so check the managed-stores list instead).
    const roleLower = (user.role || '').toLowerCase().trim();
    if (roleLower === 'manager' || roleLower === 'assistant manager') {
      if (user.store !== storeUpper)
        return json({ error: 'Cannot submit for another store' }, 403);
    } else if (roleLower === 'multi-store manager') {
      if (!MULTISTORE_MANAGER_STORES.includes(storeUpper))
        return json({ error: 'Cannot submit for a store you do not manage' }, 403);
    }

    if (!isEditablePeriod(period_type, period_end_date))
      return json({ error: 'Period is locked — only the current period is editable' }, 403);

    const pDate = new Date(period_end_date + 'T00:00:00');
    const row = {
      store: storeUpper, period_type, period_end_date,
      month: pDate.getMonth() + 1, year: pDate.getFullYear(),
      employee_name, submitted_by: pin,
      updated_at: new Date().toISOString(),
      ...fields,
    };

    const { data: upserted, error } = await supabase
      .from('kpi_entries')
      .upsert(row, { onConflict: 'store,period_type,period_end_date,employee_name' })
      .select().single();
    if (error) return json({ error: error.message }, 500);

    // Retention: weekly rows used to be pruned to the last 4 weeks per store —
    // the same 4 the grid shows — which meant the history was destroyed on every
    // save and a multi-week CSV export was impossible. Now we keep two years so
    // the date-range exporter has something to reach for. The GRID still shows
    // only 4 weeks (getRecentSundays(4) above); this is storage, not display.
    // ~5 stores x ~5 employees x 52 weeks ≈ 1.3k rows/year, so growth is a non-issue.
    const WEEKLY_KEEP_WEEKS = 104;
    if (period_type === 'weekly') {
      const { data: weeks } = await supabase
        .from('kpi_entries').select('period_end_date')
        .eq('store', storeUpper).eq('period_type', 'weekly')
        .order('period_end_date', { ascending: false });
      const unique = [...new Set((weeks || []).map((r: any) => r.period_end_date))];
      if (unique.length > WEEKLY_KEEP_WEEKS) {
        await supabase.from('kpi_entries').delete()
          .eq('store', storeUpper).eq('period_type', 'weekly')
          .in('period_end_date', unique.slice(WEEKLY_KEEP_WEEKS));
      }
    }

    // Ping open clients so the "KPIs due" reminder clears in realtime.
    await broadcastChange('kpi', storeUpper);

    return json({ success: true, entry: computeFields(upserted) });
  }

  return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
});
