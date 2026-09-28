// ============================================================================
// records-watch — the Records tab fills itself in, and a store that broke or
// came within 5% of a store record hears about it before opening.
//
// Ethan, 2026-09-28: "if a store broke their record, we can congratulate them
// and the team before the store opens and if they came within 5%, we can use it
// as motivation." Morning only, on purpose — no mid-day nudges for now.
//
// TWO KINDS OF JUDGEMENT, ONE EMAIL:
//   daily    Daily Buy / Daily Sell, for the last open day, off daily_buysell.
//   monthly  Revenue / Gross Profit / Sell Margin / Customer Conversion, for the
//            month just closed, off monthly_brief. Ethan enters the previous
//            month in the Monthly Breakdown on the 1st, so this lands on the
//            morning of the 2nd — whenever a store's four figures are all in.
//   A store gets ONE email per morning holding everything it hit, daily and
//   monthly together. Ethan: "Multiple records beaten or within the 5% on the
//   same day should be shown on one email."
//
// EACH RUN, IN THIS ORDER (the order is the correctness argument):
//   1. capture_daily_buysell() — pull the freshest buy_sell_hub into
//      daily_buysell rather than wait for the :00 capture.
//   2. JUDGE, store by store, against each record AS IT STANDS NOW, i.e. before
//      the day/month being judged could have raised it. A store is judged only
//      once its figures are in (buy AND sell > 0; all four monthly figures); a
//      late one is left for the next run. The verdict goes to record_watch_log
//      whether or not anything hit, which is what makes every later run skip it.
//   3. RAISE records from the data. Anything not judged yet is held out of this
//      scan — otherwise a late store's big day would become the record first
//      and then be judged against itself as "100%, no news".
//   4. MAIL every judged row with hits and no notified_at, grouped by store. A
//      failed send is retried next run from the logged figures, never recomputed.
//
// "WITHIN 5%" is relative everywhere: at least 95% of the record. For the two
// percentage records that is 95% of the rate (58.1% against a 61.2% margin),
// not five points.
//
// SCOPE: 2026 onward only, and a record is NEVER lowered — anything older on
// the tab (LEE's $18,086 buy, Oct 2025) predates daily_buysell and is trusted
// as typed. Correcting a record downward is still a hand edit in the Company
// Records tool, and it sticks unless the data really does beat it. That also
// means a bad data row becomes a record, and the fix is the data row.
//
// SELL MARGIN leaves out a store's opening month WHEN THAT MONTH WAS A PART
// MONTH — see MARGIN_SKIP. Not simply "the first month": MPL opened at the start
// of April 2026 and its April counts; BAL opened mid-April and its does not.
//
// COMPANY rows are the whole company summed — best day, best month — from 2026
// only. The per-card headline is the top store; see 0117 for why the two split.
//
// SUNDAY IS CLOSED: nothing runs, Monday judges Saturday. Same rule, and the
// same reason, as processed-report and cash-report.
//
// RECIPIENTS: record_watch_<STORE> (manager + ASM) plus record_watch_leadership
// (DM + CEO) on every store's mail. Leadership falls back to Ethan and Paul while
// that list is empty; a store with an empty list just goes to leadership.
//
// Params (all need ?secret=):
//   dryRun=1        judge and compute, write nothing, return JSON
//   html=<STORE>    with dryRun, return that store's email instead
//   day=YYYY-MM-DD  judge that day (and the month before it) instead of the defaults
//   to=a@b,c@d      send this run's mail there only and record nothing
//   force=1         run on a Sunday
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET = 'sp33ks-sync-k3y-2026-x9mq';
const GMAIL_RELAY = Deno.env.get('GMAIL_RELAY_URL') ||
  'https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec';
const LEADERSHIP_KEY = 'record_watch_leadership';
const FALLBACK_TO = ['ethan.kushnir@speekstechnology.com', 'paul.kushnir@pikinvestments.com'];

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const FROM = '2026-01-01';
const FROM_YEAR = 2026;
const NEAR = 0.95;        // "within 5%"
const RETRY_DAYS = 7;     // how far back an unsent mail is still worth sending

// Opening months left out of the margin record, because the store was open for
// only part of them. Ethan named these three; MPL's April 2026 is deliberately
// absent (it opened at the start of the month). A NEW STORE THAT OPENS MID-MONTH
// GOES HERE, or its first part-month will likely hold the margin record forever.
const MARGIN_SKIP: Record<string, string> = {
  OVL: '2024-09-01',
  WSP: '2025-06-01',
  BAL: '2026-04-01',
};

const L = {
  buy: 'Daily Buy Record',
  sell: 'Daily Sell Record',
  rev: 'Monthly Revenue Record',
  gp: 'Monthly Gross Profit Record',
  margin: 'Monthly Sell Margin Record',
  conv: 'Monthly Customer Conversion Record',
};
type Metric = keyof typeof L;

const STORE_COLOR: Record<string, string> = {
  OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626',
};
const STORE_TINT: Record<string, string> = {
  OVL: '#f1ebfd', LEE: '#e8f0fb', WSP: '#e8f7ee', MPL: '#fdf0e7', BAL: '#fcecec',
};
const STORE_RING: Record<string, string> = {
  OVL: '#ddd0fb', LEE: '#cfe0f7', WSP: '#c6ecd6', MPL: '#f8dcc7', BAL: '#f6d5d5',
};
// The same palette as the cash, processed and weekly mail, so they read as one family.
const C = {
  sage: '#1f9d57', charcoal: '#1a1c1e', app: '#f1f5f2', card: '#ffffff',
  soft: '#f7faf8', line: '#eaefeb', line2: '#f4f8f5',
  muted: '#64707c', faint: '#9aa6ad', footBg: '#f7faf8', gold: '#b7791f', goldBg: '#fdf6e7', goldRing: '#f3e2b8',
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: cors });

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const parseNum = (v: unknown) => {
  const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(x) ? x : null;
};

// Display text, one convention per kind of record. Daily money keeps its cents
// (a till figure); monthly money is whole dollars, which is how every monthly
// row was already typed.
const money2 = (x: number) => '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (x: number) => '$' + Math.round(x).toLocaleString('en-US');
const pct2 = (x: number) => x.toFixed(2) + '%';
const pct0 = (x: number) => Math.round(x) + '%';
const FMT: Record<Metric, (x: number) => string> = {
  buy: money2, sell: money2, rev: money0, gp: money0, margin: pct2, conv: pct0,
};
// How far apart two figures are, in words. A rate's gap is in points — "2.15
// points short" — because "$" or "%" of a percentage reads as nonsense.
const gapText = (m: Metric, d: number) =>
  m === 'margin' ? `${d.toFixed(2)} points`
    : m === 'conv' ? `${Math.round(d)} point${Math.round(d) === 1 ? '' : 's'}`
    : FMT[m](d);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const dayText = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${dd}, ${y}`;
};
const monthText = (d: string) => {
  const [y, m] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

function centralToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}
const addDays = (day: string, k: number) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};
const dowOf = (day: string) => new Date(day + 'T12:00:00Z').getUTCDay();
function lastOpenDay(today: string): string {
  let d = addDays(today, -1);
  while (dowOf(d) === 0) d = addDays(d, -1);
  return d;
}
// The first of the month before the one `day` is in.
function prevMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}
const prettyDay = (day: string) =>
  new Date(day + 'T12:00:00Z').toLocaleDateString('en-US',
    { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

type Cand = { value: number; on: string; text: string; period: string };
// Everything the email needs is baked in when the hit is judged, so a retried
// send days later says exactly what it would have said on the morning.
type Hit = {
  metric: Metric; label: string; kind: 'record' | 'near';
  value: number; prior: number; pct: number;
  valueText: string; priorText: string; gapText: string;
  priorPeriod: string; when: string;
};

// Best of a list, earliest date winning a tie — the first to reach a figure
// holds it, the same as a hand-kept board would.
function best<T>(rows: T[], val: (r: T) => number | null, on: (r: T) => string): T | null {
  let top: T | null = null, tv = -Infinity, ton = '';
  for (const r of rows) {
    const v = val(r);
    if (v === null || !Number.isFinite(v) || v <= 0) continue;
    const o = on(r);
    if (v > tv || (v === tv && o < ton)) { top = r; tv = v; ton = o; }
  }
  return top;
}

// daily_buysell passes 1,000 rows (the PostgREST cap) within a year, so it is
// read in pages — a single select would silently drop the newest days.
async function allDaily(sb: any, today: string) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('daily_buysell').select('date, store, buy, sell')
      .gte('date', FROM).lt('date', today).order('date').order('store').range(from, from + 999);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < 1000) return { data: rows, error: null };
  }
}

async function relay(to: string[], subject: string, html: string): Promise<string> {
  // redirect: 'manual' — the relay answers doPost with a 302 to an echo URL that
  // can 404 AFTER the mail went. A 3xx is a send; following it is how a
  // delivered mail gets reported as failed and then sent twice.
  const res = await fetch(GMAIL_RELAY, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ secret: SECRET, to: to.join(','), subject, html }),
  });
  if (res.status >= 300 && res.status < 400) return `sent (${res.status})`;
  const text = await res.text();
  if (!res.ok) throw new Error(`relay ${res.status}: ${text.slice(0, 200)}`);
  return text.slice(0, 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  if (url.searchParams.get('secret') !== SECRET) return out({ error: 'Unauthorized' }, 401);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const today = centralToday();
  const asked = url.searchParams.get('day');
  const day = asked || lastOpenDay(today);
  const month = prevMonth(asked ? addDays(asked, 1) : today);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const force = url.searchParams.get('force') === '1';
  const override = (url.searchParams.get('to') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const test = override.length > 0;
  const writes = !dryRun && !test;

  if (!asked && !force && !dryRun && !test && dowOf(today) === 0) {
    return out({ ok: true, skipped: 'sunday — stores closed; Saturday is judged Monday', today, day });
  }
  if (day >= today) return out({ ok: false, error: `day ${day} has not finished yet` }, 400);

  try {
    // 1. Freshest figures. A failure here is not fatal — the :00 capture is
    // still at most an hour old, and the judging step waits for real numbers.
    let captured = true;
    if (writes) {
      const { error } = await sb.rpc('capture_daily_buysell');
      if (error) captured = false;
    }

    const [recRes, dailyRes, monthRes, logRes] = await Promise.all([
      sb.from('records').select('id, store, label, value, period, value_num, record_on').is('person', null),
      allDaily(sb, today),
      sb.from('monthly_brief').select('store, year, month, metric_key, value')
        .in('metric_key', ['net_sales', 'gross_profit', 'gross_profit_pct', 'customer_close_rate', 'num_customers']),
      // Monthly rows are dated the 1st of their month, so the window starts at
      // the 1st of the month before the retry window — or last month's own
      // "already judged" row falls outside it and the month is judged again.
      sb.from('record_watch_log').select('*').gte('day', prevMonth(addDays(today, -RETRY_DAYS))),
    ]);
    for (const r of [recRes, dailyRes, monthRes, logRes]) if (r.error) throw new Error(r.error.message);

    const recs = recRes.data || [];
    const recOf = (store: string, label: string) =>
      recs.find((r: any) => r.store === store && r.label === label) as any;
    const recNum = (r: any) => r ? (r.value_num !== null && r.value_num !== undefined ? Number(r.value_num) : parseNum(r.value)) : null;

    // One metric against its record. null when there is nothing honest to say:
    // no record yet, or a record already dated on/after this period (raised by a
    // run that did not judge it).
    const judge = (s: string, m: Metric, value: number | undefined, on: string, when: string): Hit | null => {
      if (value === undefined || !(value > 0)) return null;
      const rec = recOf(s, L[m]);
      const prior = recNum(rec);
      if (!prior || (rec?.record_on && String(rec.record_on) >= on)) return null;
      // A hand-typed record carries no record_on, but its period can still say
      // it IS the period being judged ("August 2026") — the same guard.
      if (String(rec.period || '').trim().toLowerCase() === when.toLowerCase()
        || String(rec.period || '').trim().toLowerCase() === dayText(on).toLowerCase()) return null;
      // Decided at the precision the record is SHOWN: $89,486.21 has not beaten
      // a typed $89,486, it has tied it — "beat by $0" is not a record.
      const shown = (x: number) => parseNum(FMT[m](x)) ?? x;
      const sv = shown(value), sp = shown(prior);
      const pct = value / prior * 100;
      const kind = sv > sp ? 'record' : (sv >= sp * NEAR ? 'near' : null);
      if (!kind) return null;
      return {
        metric: m, label: L[m], kind, value, prior, pct,
        valueText: FMT[m](value), priorText: String(rec.value || FMT[m](prior)).trim(),
        gapText: gapText(m, Math.abs(value - prior)),
        priorPeriod: rec.period || '', when,
      };
    };

    const daily = (dailyRes.data || []).map((r: any) => ({
      date: String(r.date), store: String(r.store).toUpperCase(), buy: n(r.buy), sell: n(r.sell),
    })).filter((r) => STORES.includes(r.store));

    // Monthly: pivot monthly_brief to one row per store-month.
    type M = { store: string; mo: string; ns?: number; gp?: number; pct?: number; ccr?: number; nc?: number };
    const mm: Record<string, M> = {};
    (monthRes.data || []).forEach((r: any) => {
      const s = String(r.store).toUpperCase();
      if (!STORES.includes(s) || r.value === null) return;
      const mo = `${r.year}-${String(r.month).padStart(2, '0')}-01`;
      const k = `${s}|${mo}`;
      const row = mm[k] = mm[k] || { store: s, mo };
      const key = ({ net_sales: 'ns', gross_profit: 'gp', gross_profit_pct: 'pct',
        customer_close_rate: 'ccr', num_customers: 'nc' } as any)[r.metric_key];
      (row as any)[key] = Number(r.value);
    });
    const months = Object.values(mm).filter((r) => Number(r.mo.slice(0, 4)) >= FROM_YEAR);
    const marginCounts = (r: M) => MARGIN_SKIP[r.store] !== r.mo;

    const logs = logRes.data || [];
    const scopeOf = (l: any) => l.scope || 'daily';
    const judgedDay = new Set(logs.filter((l: any) => scopeOf(l) === 'daily' && l.day === day).map((l: any) => l.store));
    const judgedMonth = new Set(logs.filter((l: any) => scopeOf(l) === 'monthly' && l.day === month).map((l: any) => l.store));

    // 2. JUDGE.
    const verdicts: any[] = [];
    const waiting: string[] = [];
    for (const s of STORES) {
      if (judgedDay.has(s)) continue;
      const row = daily.find((r) => r.store === s && r.date === day);
      if (!row || row.buy <= 0 || row.sell <= 0) { waiting.push(`${s} ${day}`); continue; }
      const when = prettyDay(day);
      const hits = [judge(s, 'buy', row.buy, day, when), judge(s, 'sell', row.sell, day, when)].filter(Boolean);
      verdicts.push({
        day, store: s, scope: 'daily', buy: row.buy, sell: row.sell,
        buy_record: recNum(recOf(s, L.buy)), buy_period: recOf(s, L.buy)?.period || null,
        sell_record: recNum(recOf(s, L.sell)), sell_period: recOf(s, L.sell)?.period || null,
        figures: { buy: row.buy, sell: row.sell }, hits,
      });
      judgedDay.add(s);
    }
    for (const s of STORES) {
      if (judgedMonth.has(s)) continue;
      const r = mm[`${s}|${month}`];
      // All four in, or not yet: Ethan types the month in on the 1st, and a
      // run that caught him halfway must not judge half a store.
      if (!r || r.ns === undefined || r.gp === undefined || r.pct === undefined || r.ccr === undefined) {
        waiting.push(`${s} ${month.slice(0, 7)}`); continue;
      }
      const when = monthText(month);
      const hits = [
        judge(s, 'rev', r.ns, month, when),
        judge(s, 'gp', r.gp, month, when),
        marginCounts(r) ? judge(s, 'margin', r.pct, month, when) : null,
        judge(s, 'conv', r.ccr, month, when),
      ].filter(Boolean);
      verdicts.push({
        day: month, store: s, scope: 'monthly',
        figures: { net_sales: r.ns, gross_profit: r.gp, gross_profit_pct: r.pct, customer_close_rate: r.ccr }, hits,
      });
      judgedMonth.add(s);
    }
    if (writes && verdicts.length) {
      const { error } = await sb.from('record_watch_log').insert(verdicts);
      if (error) throw new Error('log: ' + error.message);
    }

    // 3. RAISE the records. A day/month on or after the one being judged only
    // counts for a store that has been judged for it (see header, step 3).
    const usable = daily.filter((r) => r.date < day || judgedDay.has(r.store));
    const usableM = months.filter((r) => r.mo < month || judgedMonth.has(r.store));
    const cands: Record<string, Cand> = {};   // key `${store}|${label}`
    const put = (store: string, m: Metric, v: number | undefined | null, on: string | undefined, monthly: boolean) => {
      if (v === undefined || v === null || !on) return;
      cands[`${store}|${L[m]}`] = { value: v, on, text: FMT[m](v), period: monthly ? monthText(on) : dayText(on) };
    };

    for (const s of STORES) {
      const mine = usable.filter((r) => r.store === s);
      const b = best(mine, (r) => r.buy, (r) => r.date); put(s, 'buy', b?.buy, b?.date, false);
      const sl = best(mine, (r) => r.sell, (r) => r.date); put(s, 'sell', sl?.sell, sl?.date, false);

      const mo = usableM.filter((r) => r.store === s);
      const rv = best(mo, (r) => r.ns ?? null, (r) => r.mo); put(s, 'rev', rv?.ns, rv?.mo, true);
      const gp = best(mo, (r) => r.gp ?? null, (r) => r.mo); put(s, 'gp', gp?.gp, gp?.mo, true);
      const mg = best(mo.filter(marginCounts), (r) => r.pct ?? null, (r) => r.mo); put(s, 'margin', mg?.pct, mg?.mo, true);
      const cv = best(mo, (r) => r.ccr ?? null, (r) => r.mo); put(s, 'conv', cv?.ccr, cv?.mo, true);
    }

    // Company daily: every store summed, on days all five were judged (or past).
    const byDate: Record<string, { buy: number; sell: number }> = {};
    const allDay = STORES.every((s) => judgedDay.has(s));
    usable.filter((r) => r.date < day || allDay).forEach((r) => {
      const t = byDate[r.date] = byDate[r.date] || { buy: 0, sell: 0 };
      t.buy += r.buy; t.sell += r.sell;
    });
    const days = Object.entries(byDate).map(([date, t]) => ({ date, ...t }));
    const cb = best(days, (r) => r.buy, (r) => r.date); put('Company', 'buy', cb?.buy, cb?.date, false);
    const cs = best(days, (r) => r.sell, (r) => r.date); put('Company', 'sell', cs?.sell, cs?.date, false);

    // Company monthly. Margin is summed GP over summed sales, leaving out any
    // store in a skipped opening month for the same reason as above. Conversion
    // is each store's close rate weighted by its # of customers.
    const allMonth = STORES.every((s) => judgedMonth.has(s));
    const byMo: Record<string, M[]> = {};
    usableM.filter((r) => r.mo < month || allMonth).forEach((r) => (byMo[r.mo] = byMo[r.mo] || []).push(r));
    const co = Object.entries(byMo).map(([mo, rs]) => {
      const sum = (f: (r: M) => number | undefined, set = rs) => set.reduce((a, r) => a + (f(r) ?? 0), 0);
      const settled = rs.filter(marginCounts);
      const sNs = sum((r) => r.ns, settled);
      const withC = rs.filter((r) => r.ccr !== undefined && r.nc);
      const cNc = sum((r) => r.nc, withC);
      return {
        mo, ns: sum((r) => r.ns), gp: sum((r) => r.gp),
        pct: sNs ? sum((r) => r.gp, settled) / sNs * 100 : null,
        ccr: cNc ? withC.reduce((a, r) => a + (r.ccr! * r.nc!), 0) / cNc : null,
      };
    });
    const crv = best(co, (r) => r.ns, (r) => r.mo); put('Company', 'rev', crv?.ns, crv?.mo, true);
    const cgp = best(co, (r) => r.gp, (r) => r.mo); put('Company', 'gp', cgp?.gp, cgp?.mo, true);
    const cmg = best(co, (r) => r.pct, (r) => r.mo); put('Company', 'margin', cmg?.pct, cmg?.mo, true);
    const ccv = best(co, (r) => r.ccr, (r) => r.mo);
    // Company conversion is a weighted average, not a whole number, so it
    // keeps two places where a store's is shown whole.
    if (ccv && ccv.ccr !== null) cands[`Company|${L.conv}`] = { value: ccv.ccr, on: ccv.mo, text: pct2(ccv.ccr), period: monthText(ccv.mo) };

    // Ratchet: only a strictly bigger number moves a record, compared RAW. At
    // display precision a typed $119,523.74 would lose to the same month shown
    // as $119,524 and be rewritten as a "new" record; raw, $69,700.53 still
    // correctly does not beat a typed $69,701. A candidate that would only
    // rewrite the text already there (57,978.30 over a typed $57,978) is skipped
    // too, so an unchanged record is not touched every morning.
    const raised: any[] = [];
    for (const [key, c] of Object.entries(cands)) {
      const [store, label] = key.split('|');
      const rec = recOf(store, label);
      const cur = recNum(rec);
      const filled = rec && String(rec.value || '').trim() !== '';
      if (filled && cur !== null && (c.value <= cur || c.text === String(rec.value).trim())) continue;
      raised.push({ store, label, from: rec?.value || null, fromPeriod: rec?.period || null, to: c.text, period: c.period });
      if (!writes) continue;
      const row = { value: c.text, period: c.period, value_num: c.value, record_on: c.on, updated_at: new Date().toISOString() };
      const q = rec
        ? sb.from('records').update(row).eq('id', rec.id)
        : sb.from('records').insert({ store, label, ...row });
      const { error } = await q;
      if (error) throw new Error(`records ${key}: ${error.message}`);
    }

    // 4. MAIL — one per store, everything it hit this morning in it. From the
    // log, not from this run's memory, so a send that failed yesterday goes out
    // today with yesterday's numbers.
    const recent = addDays(today, -RETRY_DAYS);
    const pool = test || dryRun
      ? [...verdicts, ...logs.filter((l: any) =>
          (scopeOf(l) === 'daily' && l.day === day) || (scopeOf(l) === 'monthly' && l.day === month))]
      : [...logs.filter((l: any) => !l.notified_at &&
          (scopeOf(l) === 'monthly' ? l.day >= prevMonth(recent) : l.day >= recent)), ...verdicts];
    const byStore: Record<string, any[]> = {};
    pool.filter((v: any) => (v.hits || []).length).forEach((v: any) => (byStore[v.store] = byStore[v.store] || []).push(v));
    const bundles = STORES.filter((s) => byStore[s]).map((s) => ({
      store: s, rows: byStore[s],
      // Daily first, then monthly, each in the order the tab lists them.
      hits: byStore[s].sort((a: any, b: any) => (scopeOf(a) === 'daily' ? 0 : 1) - (scopeOf(b) === 'daily' ? 0 : 1))
        .flatMap((v: any) => v.hits as Hit[]),
      day: (byStore[s].find((v: any) => scopeOf(v) === 'daily') || {}).day || null,
      month: (byStore[s].find((v: any) => scopeOf(v) === 'monthly') || {}).day || null,
    }));

    const htmlFor = url.searchParams.get('html');
    if (dryRun && htmlFor) {
      const b = bundles.find((x) => x.store === htmlFor.toUpperCase());
      if (!b) return out({ ok: false, error: `no hits for ${htmlFor}` }, 404);
      return new Response(buildEmail(b), { headers: { ...cors, 'Content-Type': 'text/html' } });
    }

    const sent: any[] = [];
    if (!dryRun && bundles.length) {
      const { data: recips } = await sb.from('email_recipients').select('list_key, email')
        .in('list_key', [LEADERSHIP_KEY, ...STORES.map((s) => `record_watch_${s}`)]);
      const list = (k: string) => (recips || []).filter((r: any) => r.list_key === k).map((r: any) => String(r.email).toLowerCase());
      const lead = list(LEADERSHIP_KEY);
      for (const b of bundles) {
        const to = test ? override
          : [...new Set([...list(`record_watch_${b.store}`), ...(lead.length ? lead : FALLBACK_TO)])];
        try {
          const r = await relay(to, subjectFor(b), buildEmail(b));
          sent.push({ store: b.store, hits: b.hits.length, to, relay: r });
          if (writes) {
            for (const v of b.rows) {
              await sb.from('record_watch_log')
                .update({ notified_at: new Date().toISOString(), recipients: to, relay: r })
                .eq('day', v.day).eq('store', v.store).eq('scope', scopeOf(v));
            }
          }
        } catch (e) {
          sent.push({ store: b.store, to, error: String((e as Error)?.message || e) });
        }
      }
    }

    return out({
      ok: true, today, day, month, dryRun, test, captured,
      judged: verdicts.map((v) => ({ store: v.store, scope: v.scope, period: v.day, figures: v.figures, hits: v.hits })),
      waiting, raised, sent,
    });
  } catch (e) {
    return out({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// The email. One per store per morning, because the news belongs to that store
// and its team; leadership is copied on each rather than sent a digest, as asked.
// Only what hit is in it — a record mail does not also report the figure that
// came nowhere near (Ethan: the 47%-of-record buy line did not belong).
// ---------------------------------------------------------------------------

type Bundle = { store: string; hits: Hit[]; day: string | null; month: string | null };

function subjectFor(b: Bundle): string {
  const recs = b.hits.filter((h) => h.kind === 'record');
  if (recs.length > 1) return `${b.store} set ${recs.length} new store records`;
  if (recs.length === 1) {
    const h = recs[0];
    const more = b.hits.length > 1 ? ' (and came close on another)' : '';
    return `${b.store} set a new ${h.label} — ${h.valueText}${more}`;
  }
  const h = b.hits.reduce((a, x) => (x.pct > a.pct ? x : a));
  const gap = 100 - h.pct;
  return gap < 0.05
    ? `${b.store} tied its ${h.label}`
    : `${b.store} came within ${gap.toFixed(1)}% of its ${h.label}`;
}

function badge(s: string) {
  return `<span style="display:inline-block;background:${STORE_TINT[s]};color:${STORE_COLOR[s]};border:1px solid ${STORE_RING[s]};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${esc(s)}</span>`;
}

function hitBlock(h: Hit) {
  const isRec = h.kind === 'record';
  // Kind was decided at display precision, so a near that is not short at that
  // precision is a tie — the pct is not, since it is taken from the raw figures.
  const tied = !isRec && parseNum(h.valueText) === parseNum(h.priorText);
  const kicker = isRec ? 'New Record' : (tied ? 'Tied the Record' : `${(100 - h.pct).toFixed(1)}% Away`);
  const was = `<b>${esc(h.priorText)}</b>${h.priorPeriod ? ` (${esc(h.priorPeriod)})` : ''}`;
  const line = isRec
    ? `Beat the old record of ${was} by <b>${esc(h.gapText)}</b>.`
    : tied
      ? `Matched the record of ${was}.`
      : `Just <b>${esc(h.gapText)}</b> short of the record of ${was}.`;
  const bg = isRec ? C.goldBg : C.soft;
  const ring = isRec ? C.goldRing : C.line;
  const accent = isRec ? C.gold : C.sage;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;background:${bg};border:1px solid ${ring};border-radius:14px;">
    <tr><td style="padding:16px 18px;">
      <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:${accent};">${kicker} &middot; ${esc(h.label)}</div>
      <div style="font-size:30px;font-weight:800;letter-spacing:-.02em;color:${C.charcoal};margin-top:6px;line-height:1.05;">${esc(h.valueText)}</div>
      <div style="font-size:11.5px;font-weight:700;color:${C.faint};margin-top:3px;">${esc(h.when)}</div>
      ${isRec ? '' : `<div style="margin-top:10px;height:8px;background:#e3ebe6;border-radius:4px;overflow:hidden;font-size:0;line-height:0;"><div style="width:${Math.min(100, h.pct).toFixed(1)}%;height:8px;background:${C.sage};border-radius:4px;font-size:0;line-height:0;">&nbsp;</div></div>
      <div style="font-size:11px;font-weight:700;color:${C.faint};margin-top:4px;">${h.pct.toFixed(1)}% of the record</div>`}
      <div style="font-size:13px;font-weight:600;color:${C.muted};margin-top:10px;line-height:1.45;">${line}</div>
    </td></tr>
  </table>`;
}

function buildEmail(b: Bundle): string {
  const recs = b.hits.filter((h) => h.kind === 'record').length;
  const title = recs > 1 ? 'New Store Records' : (recs ? 'New Store Record' : 'Close to a Store Record');
  const intro = recs > 1
    ? `${esc(b.store)} set ${recs} new store records. Congratulations to the whole team!`
    : recs
      ? `${esc(b.store)} set a new store record. Congratulations to the whole team!`
      : `${esc(b.store)} came within 5% of a store record. That's how close the team got.`;
  const when = [b.day ? prettyDay(b.day) : '', b.month ? monthText(b.month) : ''].filter(Boolean).join(' &middot; ');
  const sources = [b.day ? 'the Daily Sales Summary' : '', b.month ? 'the Monthly Breakdown' : ''].filter(Boolean).join(' and ');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:20px 24px;">
    <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:${recs ? '#f6c768' : '#6ee7a7'};">Speeks Technology &middot; Company Records</div>
    <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">${title}</div>
    <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:4px;">${badge(b.store)} &nbsp;${when}</div>
  </td></tr>
  <tr><td style="height:3px;background:${recs ? C.gold : C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:18px;">
    <div style="font-size:14px;font-weight:600;color:${C.charcoal};line-height:1.5;margin:0 2px 14px;">${intro}</div>
    ${b.hits.map(hitBlock).join('')}
  </td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.footBg};">Generated automatically by Speeks &middot; figures from ${sources}. Records are on the Records tab in SPEEKSNET.</td></tr>
</table></td></tr></table></body></html>`;
}
