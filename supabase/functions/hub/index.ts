import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function countSundays(year: number, monthIdx: number, endDay: number): number {
  let n = 0;
  for (let d = 1; d <= endDay; d++) {
    if (new Date(year, monthIdx, d).getDay() === 0) n++;
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // PRIMARY PATH: serve the cached Buying & Selling payload that the sync-buysell
  // function refreshes from the live spreadsheet (via Apps Script) on a pg_cron
  // schedule. This is the same shape the table math below produces, but always
  // current. If the cache is missing/garbled for any reason we fall through to
  // recomputing from the store_daily_* tables, so this can never be worse than
  // the old behavior.
  try {
    const { data: cacheRow } = await supabase
      .from('app_cache')
      .select('payload, synced_at')
      .eq('key', 'buy_sell_hub')
      .maybeSingle();
    const p = cacheRow?.payload as any;
    // ⚠️ GATED ON THE BUY TAB (2026-10-04), same fix as sync-buysell. It demanded
    // `ovlRev` and `leaderboard`, which come off the retired Sales tab; once
    // "Sales Oct 26" was deleted the cache never had them, and every page load
    // fell through to the table rebuild below — store_daily_* tables nothing has
    // written in months — instead of the live Buy tab.
    if (p && typeof p === 'object' && 'ovlBuyVal' in p && p.wkBuy && Array.isArray(p.wkBuy.OVL)) {
      const out = { ...p, _synced_at: cacheRow!.synced_at, _source: 'cache' };
      return new Response(JSON.stringify(out), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (_e) {
    // fall through to table computation
  }

  // Use US Central time for the current date — all stores are US-based.
  const centralNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const todayDay    = centralNow.getDate();      // day-of-month in Central time
  let year          = centralNow.getFullYear();
  let monthIdx      = centralNow.getMonth();     // 0-indexed
  const currentMonthYear = `${MON[monthIdx]} ${year}`;

  // The immediately prior calendar month — used to detect template residue.
  let pmIdx = monthIdx - 1, pmYear = year;
  if (pmIdx < 0) { pmIdx = 11; pmYear -= 1; }
  const prevMonthYear = `${MON[pmIdx]} ${pmYear}`;

  // A newly created month tab is usually copied from the prior month, so its
  // untouched days still hold the prior month's values (residue). Find the REAL
  // data "frontier": the furthest day (at or before today — real data is never
  // ahead) whose revenue differs from the prior month's same day. Days at or
  // below the frontier are shown; residue past it is ignored. This self-heals
  // — once a manager enters real numbers they stop matching last month and
  // appear automatically. The month rolls over once a frontier exists.
  const [curSalesRes, prevSalesRes] = await Promise.all([
    supabase
      .from('store_daily_sales')
      .select('store, day_number, sell_revenue')
      .eq('month_year', currentMonthYear)
      .in('store', STORES)
      .lte('day_number', todayDay),
    supabase
      .from('store_daily_sales')
      .select('store, day_number, sell_revenue')
      .eq('month_year', prevMonthYear)
      .in('store', STORES),
  ]);

  const prevSellMap = new Map<string, number>();
  for (const r of (prevSalesRes.data || [])) {
    if (r.sell_revenue != null) prevSellMap.set(`${r.store}|${r.day_number}`, Number(r.sell_revenue));
  }

  let frontierDay = 0;
  for (const r of (curSalesRes.data || [])) {
    if (r.sell_revenue == null) continue;
    const d    = Number(r.day_number);
    const prev = prevSellMap.get(`${r.store}|${d}`);
    const isResidue = prev != null && prev === Number(r.sell_revenue);
    if (!isResidue && d > frontierDay) frontierDay = d;
  }

  const hasRealDataThisMonth = frontierDay > 0;
  if (!hasRealDataThisMonth) {
    monthIdx -= 1;
    if (monthIdx < 0) { monthIdx = 11; year -= 1; }
  }

  const monthYear      = `${MON[monthIdx]} ${year}`;
  const totalDays      = getDaysInMonth(year, monthIdx);
  const totalSundays       = countSundays(year, monthIdx, totalDays);
  const workingDaysInMonth = totalDays - totalSundays;

  // For the live current month, only trust data up to the real-data frontier;
  // anything past it is leftover template residue. Past months are complete.
  const isCurrentMonth = monthYear === currentMonthYear;
  const dayCap = isCurrentMonth ? frontierDay : totalDays;

  const [buyRes, sellRes, goalsRes] = await Promise.all([
    supabase
      .from('store_daily_buying')
      .select('store, day_number, buy_amount, sell_amount, gross_margin_pct, synced_at')
      .eq('month_year', monthYear)
      .in('store', STORES)
      .order('day_number'),
    supabase
      .from('store_daily_sales')
      .select('store, day_number, sell_revenue, sell_gp')
      .eq('month_year', monthYear)
      .in('store', STORES)
      .order('day_number'),
    supabase
      .from('store_monthly_goals')
      .select('store, revenue_goal')
      .eq('month_year', monthYear),
  ]);

  const buyRows   = buyRes.data  || [];
  const sellRows  = sellRes.data || [];
  const goalsData = goalsRes.data || [];

  const result: Record<string, any> = {};
  const wkSellOut:      Record<string, number[]>        = {};
  const wkBuyOut:       Record<string, number[]>        = {};
  const wkGPOut:        Record<string, number[]>        = {};
  const wkBuyMarginOut: Record<string, number[]>        = {};
  const lbRev:          Record<string, (number|null)[]> = {};
  const lbGP:           Record<string, (number|null)[]> = {};

  for (const s of STORES) {
    const sKey = s.toLowerCase();

    const buyByDay  = new Map<number, any>();
    const sellByDay = new Map<number, any>();

    for (const r of buyRows.filter((r: any) => r.store === s)) {
      const d = Number(r.day_number);
      if (d > dayCap) continue;
      buyByDay.set(d, r);
    }

    let lastSellDay = 0;
    for (const r of sellRows.filter((r: any) => r.store === s)) {
      const d = Number(r.day_number);
      if (d > dayCap) continue;
      sellByDay.set(d, r);
      if (d > lastSellDay) lastSellDay = d;
    }

    const wkBuyArr:    number[] = new Array(31).fill(0);
    const wkBuyMgnArr: number[] = new Array(31).fill(0);
    const wkSellArr:   number[] = new Array(31).fill(0);
    const wkGPArr:     number[] = new Array(31).fill(0);

    let lastBuyDay     = 0;
    let mtdBuyCost     = 0;
    let mtdBuyTracking = 0;
    let wtBuyMgn       = 0;
    let maxSyncedAt: Date | null = null;

    for (let d = 1; d <= 31; d++) {
      const idx = d - 1;

      const br = buyByDay.get(d);
      if (br) {
        const cost    = Number(br.buy_amount)  || 0;
        const tracked = Number(br.sell_amount) || 0;
        const mgn     = Number(br.gross_margin_pct) || 0;

        wkBuyArr[idx]    = tracked;
        wkBuyMgnArr[idx] = mgn / 100;

        if (tracked > 0) {
          mtdBuyCost     += cost;
          mtdBuyTracking += tracked;
          wtBuyMgn       += tracked * (mgn / 100);
          if (d > lastBuyDay) lastBuyDay = d;
        }

        if (br.synced_at) {
          const syncDate = new Date(br.synced_at);
          if (!maxSyncedAt || syncDate > maxSyncedAt) maxSyncedAt = syncDate;
        }
      }

      const sr = sellByDay.get(d);
      if (sr) {
        wkSellArr[idx] = Number(sr.sell_revenue) || 0;
        wkGPArr[idx]   = Number(sr.sell_gp)      || 0;
      }
    }

    const buyMarginAvg = mtdBuyTracking > 0 ? wtBuyMgn / mtdBuyTracking : 0;

    const sundaysElapsed     = lastBuyDay > 0 ? countSundays(year, monthIdx, lastBuyDay) : 0;
    const workingDaysElapsed = lastBuyDay - sundaysElapsed;
    const buyProj = workingDaysElapsed > 0
      ? (mtdBuyTracking / workingDaysElapsed) * workingDaysInMonth
      : 0;

    let buyDate = '';
    if (maxSyncedAt) {
      buyDate = maxSyncedAt.toLocaleDateString('en-US', {
        timeZone: 'America/Chicago',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    } else if (lastBuyDay > 0) {
      buyDate = `${DOW[new Date(year, monthIdx, lastBuyDay).getDay()]}, ${MON[monthIdx]} ${lastBuyDay}`;
    }

    let mtdRev = 0, mtdGP = 0;
    for (let d = 0; d < lastSellDay; d++) {
      mtdRev += wkSellArr[d];
      mtdGP  += wkGPArr[d];
    }
    const sellMargin = mtdRev > 0 ? mtdGP / mtdRev : 0;

    const daysElapsed = lastSellDay || lastBuyDay;
    const trackRev = daysElapsed > 0 ? (mtdRev / daysElapsed) * totalDays : 0;
    const trackGP  = daysElapsed > 0 ? (mtdGP  / daysElapsed) * totalDays : 0;

    const goalRow = goalsData.find((r: any) => r.store === s);
    const gpGoal  = Number(goalRow?.revenue_goal) || 0;
    const pct     = gpGoal > 0 ? (trackGP / gpGoal) * 100 : 0;

    const revCum: (number|null)[] = new Array(31).fill(null);
    const gpCum:  (number|null)[] = new Array(31).fill(null);
    if (lastSellDay > 0) {
      let cumRev = 0, cumGP = 0;
      for (let d = 0; d < lastSellDay; d++) {
        cumRev += wkSellArr[d];
        cumGP  += wkGPArr[d];
        revCum[d] = Math.round(cumRev * 100) / 100;
        gpCum[d]  = Math.round(cumGP  * 100) / 100;
      }
    }

    wkSellOut[s]      = wkSellArr;
    wkBuyOut[s]       = wkBuyArr;
    wkGPOut[s]        = wkGPArr;
    wkBuyMarginOut[s] = wkBuyMgnArr;
    lbRev[s]          = revCum;
    lbGP[s]           = gpCum;

    result[`${sKey}Rev`]        = Math.round(mtdRev  * 100) / 100;
    result[`${sKey}Goal`]       = gpGoal;
    result[`${sKey}GP`]         = Math.round(mtdGP   * 100) / 100;
    result[`${sKey}Pct`]        = pct;
    result[`${sKey}TrackRev`]   = trackRev;
    result[`${sKey}TrackGP`]    = trackGP;
    result[`${sKey}SellMargin`] = sellMargin;
    result[`${sKey}BuyVal`]     = Math.round(mtdBuyCost);
    result[`${sKey}BuyMargin`]  = buyMarginAvg;
    result[`${sKey}BuyProj`]    = Math.round(buyProj * 100) / 100;
    result[`${sKey}BuyDate`]    = buyDate;
  }

  result.wkSell         = wkSellOut;
  result.wkBuy          = wkBuyOut;
  result.wkGP           = wkGPOut;
  result.wkBuyMarginPct = wkBuyMarginOut;
  result.leaderboard    = {
    activeStores: [...STORES],
    revenue: lbRev,
    gp:      lbGP,
  };
  result._source = 'tables';

  return new Response(JSON.stringify(result), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
