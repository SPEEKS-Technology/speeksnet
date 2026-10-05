// ============================================================================
// SPEEKS Weekly Report  —  Supabase Edge Function
// ----------------------------------------------------------------------------
// Builds two HTML emails for the Mon–Sun week that just ended and sends them
// via Resend:
//   • Leadership (DM/CEO) — all stores, comparative
//   • Store Manager      — one per store, scoped + full comparison leaderboard
//
// Data sources (all live in Supabase):
//   • app_cache.buy_sell_hub  — daily buy/sell/GP arrays + monthly GP goal
//                               (GP months; buying in every month — see below)
//   • daily_np                — per store per day Sales/GP/fees/NP, mirrored from
//                               the workbook's Net Profit tab by np-sync (NP months)
//   • monthly_np_goals        — the month's NP goal per store (NP months)
//   • kpi_entries             — weekly per-employee listings/conversion
//   • day_end_facts           — the store's weekly LISTED total (from 2026-08-03)
//   • scorecards              — category scores
//   • store_targets           — weekly listing targets + team size
//   • checklist_completions   — ops activity
//
// Trigger:
//   POST/GET  ?secret=...                run for last completed week, real recipients
//   &weekEnd=2026-06-21                  override the Sunday week-end
//   &to=ethan@...                        TEST: send everything to one address
//   &types=both|leadership|manager       which report(s)
//   &stores=BAL,LEE                      limit manager reports to these stores
//   &dryRun=1                            return HTML, don't send (and don't snapshot)
//   &dryRun=1&preview=manager&stores=LEE the manager email for one store instead
//
// NET PROFIT FROM OCTOBER 2026 (2026-10-02). The company is graded on Net Profit
// from October, not Gross Profit (Paul's call). A report week whose Sunday falls
// in an NP month (weekEnd >= NP_FROM) therefore:
//   • ranks the leaderboard on the week's NET profit and measures goal pace on
//     MTD NP against monthly_np_goals — the GP goal is not shown at all, because
//     a GP number beside an NP-graded store reads as a store miles ahead of plan;
//   • takes the week's and the month's Sales / GP / NP from daily_np, NOT from
//     the hub, because the hub comes from the Sales Summary sheet being retired
//     and daily_np is the mirror of the tab Paul and Ethan actually read;
//   • adds "Where the GP Went": eBay fees and shipping as % of sales MTD, store vs
//     district, red when a store is more than LEAK_FLAG_PTS above the district on
//     either. That is the CEO/DM ask — GP is the same game it always was, and the
//     two costs a store can actually move between GP and NP are those two.
// Buying (wkBuy / wkBuyMarginPct) still comes from the hub in every month: the
// NP tab carries no buying figures. When the hub goes, buying needs a new home.
// GP months (before NP_FROM) render exactly as they did before this change.
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SECRET       = 'sp33ks-sync-k3y-2026-x9mq';
const RESEND_URL   = 'https://api.resend.com/emails';
// Until speekstechnology.com is verified in Resend, the test uses Resend's
// onboarding sender (can only deliver to the Resend account owner's address).
const FROM         = Deno.env.get('RESEND_FROM') || 'Speeks Reports <onboarding@resend.dev>';
// Gmail relay (Apps Script web app) — sends via GmailApp, no DNS needed.
const GMAIL_RELAY  = Deno.env.get('GMAIL_RELAY_URL') || 'https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec';
const DEFAULT_TO   = 'ethan.kushnir@speekstechnology.com';

// Leadership (DM/CEO) recipients.
// NOTE: both lists are FALLBACKS — loadRecipients() overwrites them from the
// email_recipients table (managed via the DM's Email Recipients tool) on every
// run. Editing recipients happens in that tool, not here.
let LEADERSHIP_TO: string[] = ['ethan.kushnir@speekstechnology.com', 'paul.kushnir@pikinvestments.com'];
// Per-store manager recipients. Falls back to DEFAULT_TO if a store is empty.
// (Multi-store managers are listed under each store they run.)
let STORE_TO: Record<string, string[]> = {
  OVL: ['nickhett707@gmail.com'],
  LEE: ['jurellguild@outlook.com'],
  WSP: ['eli.kushnir@speekstechnology.com'],
  MPL: ['josephorte191@hotmail.com'],
  BAL: ['josephorte191@hotmail.com'],
};

// Overwrite the recipient lists from the email_recipients table (keys
// weekly_leadership / weekly_store_<STORE>). Rows win over the constants
// above; a list with no rows keeps its fallback.
async function loadRecipients(sb: any) {
  try {
    const { data } = await sb.from('email_recipients').select('list_key, email');
    if (!data?.length) return;
    const lists: Record<string, string[]> = {};
    data.forEach((r: any) => { (lists[r.list_key] = lists[r.list_key] || []).push(r.email); });
    if (lists['weekly_leadership']?.length) LEADERSHIP_TO = lists['weekly_leadership'];
    STORES.forEach((s) => {
      if (lists[`weekly_store_${s}`]?.length) STORE_TO[s] = lists[`weekly_store_${s}`];
    });
  } catch (_e) { /* keep fallbacks */ }
}

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const STORE_NAME: Record<string, string> = {
  OVL: 'Overland Park', LEE: "Lee's Summit", WSP: 'Westport', MPL: 'Maplewood', BAL: 'Ballwin',
};
const STORE_COLOR: Record<string, string> = {
  OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626',
};
// Airy V4 keeps each store's hue for identity but wears it as a tinted chip
// (fill + text + hairline) instead of a solid block — same treatment the site
// uses everywhere else. STORE_COLOR stays the text/keyline colour.
const STORE_TINT: Record<string, string> = {
  OVL: '#f1ebfd', LEE: '#e8f0fb', WSP: '#e8f7ee', MPL: '#fdf0e7', BAL: '#fcecec',
};
const STORE_RING: Record<string, string> = {
  OVL: '#ddd0fb', LEE: '#cfe0f7', WSP: '#c6ecd6', MPL: '#f8dcc7', BAL: '#f6d5d5',
};

// Brand palette — Airy V4 (matches the redesigned pages, which flip
// --sage-professional to the fresh emerald and drop the cool slate neutrals for
// green-biased ones). See the "V4 airy" block in styles.css.
const C = {
  sage: '#1f9d57', sageDeep: '#178048', tint: '#e8f7ee',
  charcoal: '#1a1c1e', app: '#f1f5f2', card: '#ffffff', soft: '#f7faf8',
  green: '#1f9d57', amber: '#c07f0c', red: '#d64545', gold: '#e8a020',
  line: '#eaefeb', line2: '#f4f8f5', track: '#eaefeb',
  muted: '#64707c', faint: '#9aa6ad',
  // warning surfaces (flags block, incomplete-KPI rows) on the site's gold tint
  flagBg: '#fefaf3', flagRule: '#f4e3c4', flagBorder: '#f0dcb6', flagHead: '#fdf3e1', flagInk: '#8a5a06',
  footBg: '#f7faf8',
  rCard: 18, rBox: 14,
};

// The SPEEKS Scorecard is now just the "Online & Marketing" four categories.
// NOTE: both lists below are FALLBACKS — loadReportCatalogs() overwrites them
// from the scorecard_items / paymore_audit_items tables (the Manage Items tab)
// at the start of every run, so catalog edits show up in the emails.
let SCORECARD_CATS: [string, string][] = [
  ['online_store_pictures', 'Online Store Pictures'],
  ['facebook_listings', 'Facebook Listings'],
  ['social_media_posts', 'Social Media Posts'],
  ['paymore_sync', 'PayMore Sync'],
];

// PayMore Audit Playbook v3 — section → item points (id:pts). Used to show
// per-section subtotals (where points were lost) in the manager email; the full
// item-level breakdown lives in the dashboard popout. (Totals = 165.)
let AUDIT_SECTIONS: { title: string; items: Record<string, number> }[] = [
  { title: 'Exterior', items: { ex1:1, ex2:1, ex3:1 } },
  { title: 'Entry & Sales Floor', items: { ef1:1, ef2:1, ef3:1, ef4:1, ef5:1, ef6:2, ef7:1, ef8:1, ef9:1, ef10:2, ef11:1, ef12:1, ef13:1, ef14:3 } },
  { title: 'Display Cases & Merchandising', items: { dc1:1, dc2:1, dc3:1, dc4:2, dc5:1, dc6:2, dc7:2, dc8:2, dc9:3, dc10:2, dc11:3, dc12:2 } },
  { title: 'Retail Counter', items: { rc1:1, rc2:1, rc3:1, rc4:1, rc5:1, rc6:1, rc7:2, rc8:1 } },
  { title: 'Buy Transaction Area', items: { bt1:3, bt2:1, bt3:2, bt4:2, bt5:1, bt6:1, bt7:2, bt8:3, bt9:7, bt10:3, bt11:3, bt12:4 } },
  { title: 'Back of House', items: { bh1:1, bh2:2, bh3:1, bh4:2, bh5:1, bh6:1, bh7:1, bh8:1, bh9:2, bh10:1, bh11:2, bh12:2, bh13:1, bh14:3, bh15:1, bh16:3, bh17:3, bh18:1, bh19:2, bh20:2, bh21:5, bh22:2, bh23:4, bh24:1, bh25:1, bh26:1 } },
  { title: 'Personnel & Appearance', items: { pa1:1, pa2:1, pa3:1, pa4:1, pa5:1, pa6:1 } },
  { title: 'Safety & Security', items: { ss1:3, ss2:2, ss3:2, ss4:4, ss5:5, ss6:2, ss7:1, ss8:1, ss9:1, ss10:4, ss11:1, ss12:1, ss13:1 } },
];

// Overwrite the hardcoded lists above from the DB item catalog (active items
// only, catalog order). Any failure leaves the hardcoded fallbacks in place.
async function loadReportCatalogs(sb: any) {
  try {
    const [{ data: sc }, { data: au }] = await Promise.all([
      sb.from('scorecard_items').select('*').order('sort_order', { ascending: true }),
      sb.from('paymore_audit_items').select('*').order('sort_order', { ascending: true }),
    ]);
    const scActive = (sc || []).filter((i: any) => i.active);
    if (scActive.length) SCORECARD_CATS = scActive.map((i: any) => [i.item_key, i.label]);
    const auActive = (au || []).filter((i: any) => i.active);
    if (auActive.length) {
      const secs: { title: string; items: Record<string, number> }[] = [];
      const idx: Record<string, number> = {};
      auActive.forEach((i: any) => {
        if (!(i.section in idx)) { idx[i.section] = secs.length; secs.push({ title: i.section, items: {} }); }
        secs[idx[i.section]].items[i.item_id] = Number(i.points) || 0;
      });
      AUDIT_SECTIONS = secs;
    }
  } catch (_e) { /* keep the hardcoded fallbacks */ }
}

// Scorecard category value from a scorecards row: prefer the `scores` jsonb
// blob (catalog-added categories live only there), fall back to the legacy
// per-category column for old rows.
function cardVal(card: any, key: string): number | null {
  if (!card) return null;
  const blob = card.scores && typeof card.scores === 'object' ? card.scores : null;
  const v = blob && blob[key] !== undefined ? blob[key] : card[key];
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// Per-section earned/total. results[id] is points awarded (0..pts);
// legacy boolean true = full pts.
function auditSectionBreakdown(results: Record<string, any>) {
  return AUDIT_SECTIONS.map((sec) => {
    let earned = 0, total = 0;
    for (const [id, pts] of Object.entries(sec.items)) {
      total += pts;
      const v = results ? results[id] : 0;
      let a = v === true ? pts : Number(v);
      if (!Number.isFinite(a)) a = 0;
      earned += Math.min(Math.max(a, 0), pts);
    }
    return { title: sec.title, earned, total };
  });
}

// ---------- small helpers ----------
const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return isNaN(x) ? 0 : x; };
const money = (v: number) => '$' + Math.round(v).toLocaleString('en-US');
const moneyK = (v: number) => '$' + (Math.round(v / 100) / 10).toLocaleString('en-US') + 'k';
const pct = (v: number, d = 1) => v.toFixed(d) + '%';
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const gpColor = (m: number) => (m >= 40 ? C.green : m >= 30 ? C.amber : C.red);
const buyColor = (m: number) => (m >= 51 ? C.green : C.red);
const tgtColor = (p: number) => (p >= 100 ? C.green : p >= 80 ? C.amber : C.red);
const scoreColor = (s10: number) => (s10 >= 8 ? C.green : s10 >= 6 ? C.amber : C.red);

// First Monday day_end_facts covers whole — the same cut-over store-targets uses.
const DAY_END_FROM = '2026-08-03';

// First Net Profit month — same rule, same constant, as gp-goals and
// buysell-daily. A report belongs to the month its Sunday falls in.
const NP_FROM = '2026-10';
// "Where the GP Went" flags a store this many percentage points of sales above
// the district on eBay fees or on shipping (Ethan, 2026-10-02: 1.0 point).
const LEAK_FLAG_PTS = 1.0;
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

function pad(d: number) { return d < 10 ? '0' + d : '' + d; }
function ymd(d: Date) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function parseYMD(s: string) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function fmtMD(d: Date) { return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }); }

// Last completed Sunday (in America/Chicago) relative to "now".
function lastSundayCentral(): Date {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const dow = now.getDay();                 // 0=Sun
  const back = dow === 0 ? 7 : dow;         // most recent past Sunday
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

// ---------- data assembly ----------
async function gather(sb: any, weekEnd: Date) {
  const weekStart = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - 6);
  const endDay = weekEnd.getDate();
  const startDay = weekStart.getDate();
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const daysInMonth = new Date(weekEnd.getFullYear(), weekEnd.getMonth() + 1, 0).getDate();
  const weekEndStr = ymd(weekEnd);
  const weekStartStr = ymd(weekStart);
  const ym = weekEndStr.slice(0, 7);
  const npMonth = ym >= NP_FROM;
  const monthStartStr = ym + '-01';

  // 1) buy/sell hub cache
  const { data: cacheRow } = await sb.from('app_cache').select('payload').eq('key', 'buy_sell_hub').single();
  const hub = cacheRow?.payload ?? {};
  const arr = (group: string, store: string): number[] => (hub?.[group]?.[store] ?? []) as number[];
  const sumDays = (a: number[]) => {
    let s = 0;
    const lo = sameMonth ? startDay : 1;     // cross-month weeks: sum this month's portion (see note in report)
    for (let d = lo; d <= endDay; d++) s += n(a[d - 1]);
    return s;
  };

  // 1b) Net Profit months: the week and the month-to-date off daily_np.
  // One read covers both — from whichever is earlier, the Monday or the 1st.
  // Unlike the hub's per-month arrays this sees the WHOLE week when it crosses
  // a month end (Sep 28 – Oct 4 is all seven days, not just Oct 1–4), because
  // np-sync mirrors last month too through the 5th.
  //
  // A failed read THROWS rather than falling back to the hub: the fallback would
  // be a GP figure in a Net Profit column, sent to every store as fact. A 500 to
  // the cron is louder and wrong in a way someone notices.
  //
  // Nulls are kept apart from zeros:
  //   • np null        — the tab has no NP for that day; the day doesn't count
  //                      toward days-with-NP, so it can't drag the pace down.
  //   • shipping null  — not written yet. The 6:10am pass writes everything but
  //                      shipping; shipping lands at the 2:05pm pass the next day,
  //                      so at 8:30 Monday SUNDAY ALWAYS HAS NONE. That day is
  //                      left out of the shipping % (numerator AND denominator),
  //                      and its NP is provisional — the email says so.
  //   • ebay_fee null  — the eBay pass failed (=NA() on the tab); same treatment
  //                      for the eBay %.
  const npBy: Record<string, any> = {};
  const npGoalBy: Record<string, number> = {};
  const npGoalSet: Record<string, boolean> = {};
  const provisionalDates = new Set<string>();
  if (npMonth) {
    for (const s of STORES) npBy[s] = {
      wk: { sales: 0, gp: 0, np: 0, days: 0 },
      mtd: { sales: 0, gp: 0, np: 0, npDays: 0, ebay: 0, ebaySales: 0, ship: 0, shipSales: 0 },
    };
    const from = weekStartStr < monthStartStr ? weekStartStr : monthStartStr;
    const { data: npRows, error: npErr } = await sb.from('daily_np')
      .select('date, store, sales, gp, ebay_fee, shipping_cost, np, shipping_final')
      .gte('date', from).lte('date', weekEndStr);
    if (npErr) throw new Error('daily_np read failed: ' + npErr.message);
    for (const r of npRows ?? []) {
      const b = npBy[String(r.store || '').toUpperCase()];
      if (!b) continue;
      const date = String(r.date).slice(0, 10);
      const sales = n(r.sales);
      if (date >= weekStartStr && r.np != null) {
        b.wk.sales += sales; b.wk.gp += n(r.gp); b.wk.np += n(r.np); b.wk.days++;
      }
      if (date >= monthStartStr) {
        b.mtd.sales += sales; b.mtd.gp += n(r.gp);
        if (r.np != null) { b.mtd.np += n(r.np); b.mtd.npDays++; }
        if (r.ebay_fee != null) { b.mtd.ebay += n(r.ebay_fee); b.mtd.ebaySales += sales; }
        if (r.shipping_cost != null) { b.mtd.ship += n(r.shipping_cost); b.mtd.shipSales += sales; }
      }
      if (date >= monthStartStr && (r.shipping_cost == null || !r.shipping_final)) provisionalDates.add(date);
    }
    // The month's NP goal is the record on SPEEKS (Month Setup → gp-goals), never
    // the hub's figure — that one is the Sales tab's GP goal.
    const { data: goalRows, error: goalErr } = await sb.from('monthly_np_goals').select('store, np_goal').eq('ym', ym);
    if (goalErr) throw new Error('monthly_np_goals read failed: ' + goalErr.message);
    for (const g of goalRows ?? []) {
      const code = String(g.store || '').toUpperCase();
      npGoalBy[code] = n(g.np_goal); npGoalSet[code] = true;
    }
  }

  // 2) weekly KPI rows for the week-ending Sunday
  const kpis = (await sb.from('kpi_entries').select('*')
    .eq('period_type', 'weekly').eq('period_end_date', weekEndStr)).data ?? [];

  // 2b) the store's LISTED count for the week, off the Day End Report — the same
  // figure the goals board and Store Efficiency count (store-targets explains
  // the switch; Ethan: not relying on managers to pull the data the right way).
  // Per day: Total Listed Devices from 2026-09-23, Devices Processed before it.
  // A store with no report rows for the week, or a week before DAY_END_FROM,
  // keeps the KPI total — there is nothing else to count it from.
  const dayEndListed: Record<string, number> = {};
  if (weekStartStr >= DAY_END_FROM) {
    const de = (await sb.from('day_end_facts').select('store, listed_devices, devices_processed')
      .gte('date', ymd(weekStart)).lte('date', weekEndStr)).data ?? [];
    for (const r of de) {
      const v = r.listed_devices != null ? n(r.listed_devices) : n(r.devices_processed);
      dayEndListed[r.store] = (dayEndListed[r.store] ?? 0) + v;
    }
  }

  // 3) store targets
  const targets = (await sb.from('store_targets').select('*')).data ?? [];
  const targetBy: Record<string, any> = {};
  for (const t of targets) targetBy[t.store] = t;

  // 4) latest scorecard per store on/before the week-end
  const cards = (await sb.from('scorecards').select('*')
    .lte('date', weekEndStr).order('date', { ascending: false })).data ?? [];
  const cardBy: Record<string, any> = {};
  for (const c of cards) if (!cardBy[c.store]) cardBy[c.store] = c;

  // 4b) latest PayMore practice-audit score per store on/before the week-end
  const auditScores = (await sb.from('audit_scores').select('store, date, earned_points, possible_points, pct, results')
    .lte('date', weekEndStr).order('date', { ascending: false })).data ?? [];
  const auditBy: Record<string, any> = {};
  for (const a of auditScores) if (!auditBy[a.store]) auditBy[a.store] = a;

  // 5) store-audit readiness for this week (Daily + Weekly checklists)
  const auditItems = (await sb.from('audit_items').select('id, period, active').eq('active', true)).data ?? [];
  const dailyIds = new Set(auditItems.filter((a: any) => a.period === 'daily').map((a: any) => a.id));
  const weeklyIds = new Set(auditItems.filter((a: any) => a.period !== 'daily').map((a: any) => a.id));
  const auditDailyTotal = dailyIds.size;
  const auditWeeklyTotal = weeklyIds.size;
  // period_start within the report week: daily rows land on each day; the weekly row lands on Monday (= weekStartStr).
  const auditComps = (await sb.from('audit_completions').select('store, item_id, period_start')
    .gte('period_start', weekStartStr).lte('period_start', weekEndStr)).data ?? [];
  const auditDailyCount: Record<string, number> = {};
  const auditWeeklyCount: Record<string, number> = {};
  for (const c of auditComps) {
    if (dailyIds.has(c.item_id)) auditDailyCount[c.store] = (auditDailyCount[c.store] || 0) + 1;
    else if (weeklyIds.has(c.item_id) && c.period_start === weekStartStr) auditWeeklyCount[c.store] = (auditWeeklyCount[c.store] || 0) + 1;
  }

  // ----- per-store rollups -----
  const rows: Record<string, any> = {};
  for (const s of STORES) {
    const buyA = arr('wkBuy', s), sellA = arr('wkSell', s), gpA = arr('wkGP', s), bmA = arr('wkBuyMarginPct', s);
    const boughtResale = sumDays(buyA);
    let cash = 0;
    const lo = sameMonth ? startDay : 1;
    for (let d = lo; d <= endDay; d++) cash += n(buyA[d - 1]) * (1 - n(bmA[d - 1]));
    let soldRev = sumDays(sellA);
    let soldGp = sumDays(gpA);
    // NP months: the week's selling is daily_np's (see 1b). A store with no NP
    // rows for the week keeps the hub's sales/GP and shows no NP — a dash, not $0.
    const npb = npBy[s];
    let soldNp: number | null = null;
    if (npMonth && npb && npb.wk.days) { soldRev = npb.wk.sales; soldGp = npb.wk.gp; soldNp = npb.wk.np; }

    // listings (single week)
    const k = kpis.filter((r: any) => r.store === s);
    // Store total from the Day End Report (see 2b); the per-person rows below
    // and the Top Performer stay on the KPI, which is the only place a person's
    // listings sit beside their conversion and listing dollars.
    const processed = dayEndListed[s] != null
      ? dayEndListed[s]
      : k.reduce((a: number, r: any) => a + n(r.listed_count), 0);
    const retail = k.reduce((a: number, r: any) => a + n(r.listed_retail_price), 0);
    const lcost = k.reduce((a: number, r: any) => a + n(r.listed_cost), 0);
    const lsold = k.reduce((a: number, r: any) => a + n(r.listed_sold_value), 0);
    const tgt = targetBy[s]?.current_target ?? 0;

    // MTD GP through endDay (cumulative array), with projection
    const gpCum = arr('leaderboard.gp', s).length ? arr('leaderboard.gp', s) : (hub?.leaderboard?.gp?.[s] ?? []);
    let gpMtd = 0;
    for (let d = endDay; d >= 1; d--) { const v = n(gpCum[d - 1]); if (v) { gpMtd = v; break; } }
    let gpGoal = n(hub?.[s.toLowerCase() + 'Goal']);
    let gpProj = endDay > 0 ? (gpMtd / endDay) * daysInMonth : 0;

    // NP months: MTD NP against the NP goal, tracking = MTD NP ÷ days-with-NP ×
    // days in month. Days-with-NP, not the calendar day: today never has a row
    // and the report week's Sunday may be the last one in, so dividing by the
    // calendar would under-project every store on every run. gpMtd stays GP
    // (from daily_np) for the snapshot; there is no GP goal in an NP month.
    let npMtd = 0, npGoal = 0, npProj = 0, npDays = 0, goalSet = false;
    let leak: any = null;
    if (npMonth && npb) {
      const m = npb.mtd;
      npMtd = m.np; npDays = m.npDays; npGoal = npGoalBy[s] ?? 0; goalSet = !!npGoalSet[s];
      npProj = npDays ? (npMtd / npDays) * daysInMonth : 0;
      gpMtd = m.gp; gpGoal = 0; gpProj = npDays ? (m.gp / npDays) * daysInMonth : 0;
      leak = {
        sales: m.sales, gp: m.gp, np: m.np, ebay: m.ebay, ship: m.ship,
        ebaySales: m.ebaySales, shipSales: m.shipSales,
        gpPct: m.sales ? (m.gp / m.sales) * 100 : null,
        npPct: m.sales ? (m.np / m.sales) * 100 : null,
        ebayPct: m.ebaySales ? (m.ebay / m.ebaySales) * 100 : null,
        shipPct: m.shipSales ? (m.ship / m.shipSales) * 100 : null,
      };
    }

    rows[s] = {
      store: s,
      boughtResale, boughtCash: cash, buyMargin: boughtResale ? ((boughtResale - cash) / boughtResale) * 100 : 0,
      soldRev, soldGp, gpMargin: soldRev ? (soldGp / soldRev) * 100 : 0,
      processed, retail, listedMargin: retail ? ((retail - lcost) / retail) * 100 : 0,
      pctSold: retail ? (lsold / retail) * 100 : 0,
      target: tgt, listingPct: tgt ? (processed / tgt) * 100 : 0, people: k.length,
      gpMtd, gpGoal, gpProj,
      soldNp, npMargin: soldNp != null && soldRev ? (soldNp / soldRev) * 100 : null,
      npMtd, npGoal, npProj, npDays, goalSet, leak, npMonth,
      // goalPct is whichever goal this month is graded on.
      goalPct: npMonth ? (npGoal ? (npProj / npGoal) * 100 : 0) : (gpGoal ? (gpProj / gpGoal) * 100 : 0),
      card: cardBy[s] || null,
      audit: auditBy[s] ? { earned: auditBy[s].earned_points, possible: auditBy[s].possible_points, pct: Number(auditBy[s].pct), date: auditBy[s].date, results: auditBy[s].results || {} } : null,
      auditWeeklyPct: auditWeeklyTotal ? ((auditWeeklyCount[s] || 0) / auditWeeklyTotal) * 100 : null,
      auditDailyPct: auditDailyTotal ? ((auditDailyCount[s] || 0) / (auditDailyTotal * 7)) * 100 : null,
      kpiSubmitted: k.length > 0,
    };
  }

  // company totals
  const tot = (f: (r: any) => number) => STORES.reduce((a, s) => a + f(rows[s]), 0);
  const company = {
    boughtResale: tot(r => r.boughtResale), boughtCash: tot(r => r.boughtCash),
    soldRev: tot(r => r.soldRev), soldGp: tot(r => r.soldGp),
    processed: tot(r => r.processed), retail: tot(r => r.retail),
    lsoldVal: tot(r => r.pctSold * r.retail / 100),
    target: tot(r => r.target), people: tot(r => r.people),
    gpMtd: tot(r => r.gpMtd), gpGoal: tot(r => r.gpGoal), gpProj: tot(r => r.gpProj),
  } as any;
  company.buyMargin = company.boughtResale ? ((company.boughtResale - company.boughtCash) / company.boughtResale) * 100 : 0;
  company.gpMargin = company.soldRev ? (company.soldGp / company.soldRev) * 100 : 0;
  company.listingPct = company.target ? (company.processed / company.target) * 100 : 0;
  company.listedMargin = company.retail ? ((company.retail - tot(r => r.retail - r.retail * r.listedMargin / 100)) / company.retail) * 100 : 0;
  company.pctSold = company.retail ? (company.lsoldVal / company.retail) * 100 : 0;
  company.goalPct = company.gpGoal ? (company.gpProj / company.gpGoal) * 100 : 0;
  company.npMonth = npMonth;
  if (npMonth) {
    // District = the five stores pooled (sum ÷ sum), not an average of the five
    // percentages — a small store's 9% shouldn't weigh what OVL's sales do.
    const withNp = STORES.filter(s => rows[s].soldNp != null);
    company.soldNp = withNp.length ? withNp.reduce((a, s) => a + rows[s].soldNp, 0) : null;
    company.npMargin = company.soldNp != null && company.soldRev ? (company.soldNp / company.soldRev) * 100 : null;
    company.npMtd = tot(r => r.npMtd); company.npGoal = tot(r => r.npGoal); company.npProj = tot(r => r.npProj);
    company.npDays = Math.max(0, ...STORES.map(s => rows[s].npDays));
    company.goalSet = STORES.every(s => rows[s].goalSet);
    company.goalPct = company.npGoal ? (company.npProj / company.npGoal) * 100 : 0;
    const L = (f: (l: any) => number) => STORES.reduce((a, s) => a + (rows[s].leak ? f(rows[s].leak) : 0), 0);
    const sales = L(l => l.sales), gp = L(l => l.gp), np = L(l => l.np);
    const ebay = L(l => l.ebay), ebaySales = L(l => l.ebaySales), ship = L(l => l.ship), shipSales = L(l => l.shipSales);
    company.leak = {
      sales, gp, np, ebay, ship, ebaySales, shipSales,
      gpPct: sales ? (gp / sales) * 100 : null, npPct: sales ? (np / sales) * 100 : null,
      ebayPct: ebaySales ? (ebay / ebaySales) * 100 : null, shipPct: shipSales ? (ship / shipSales) * 100 : null,
    };
    // A store is flagged on a cost when it runs more than LEAK_FLAG_PTS of sales
    // above the district on it. Points, not a ratio: 1 point of a $100k month is
    // $1,000 of NP whichever store it is.
    for (const s of STORES) {
      const l = rows[s].leak; if (!l) continue;
      l.ebayGap = l.ebayPct != null && company.leak.ebayPct != null ? l.ebayPct - company.leak.ebayPct : null;
      l.shipGap = l.shipPct != null && company.leak.shipPct != null ? l.shipPct - company.leak.shipPct : null;
      l.ebayHi = l.ebayGap != null && l.ebayGap > LEAK_FLAG_PTS;
      l.shipHi = l.shipGap != null && l.shipGap > LEAK_FLAG_PTS;
    }
  }
  const provisional = [...provisionalDates].sort();

  // top performer (by listings) + flags
  const sortedKpis = [...kpis].sort((a, b) => n(b.listed_count) - n(a.listed_count));
  const topPerformer = sortedKpis[0] || null;
  const incomplete = kpis.filter((r: any) =>
    (r.listed_count != null && (r.listed_retail_price == null || r.listed_cost == null)) || r.buying_value == null
  ).map((r: any) => ({
    name: r.employee_name, store: r.store,
    what: (r.listed_count != null && (r.listed_retail_price == null || r.listed_cost == null)) ? 'listing $ missing' : 'buying $ missing',
  }));

  // lowest company scorecard category (avg across stores that scored it, ×2 /10)
  let lowestCat = ''; let lowestVal = 99;
  for (const [key, label] of SCORECARD_CATS) {
    const vals = STORES.map(s => cardVal(rows[s].card, key)).filter(v => v != null).map(v => n(v) * 2);
    if (!vals.length) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg < lowestVal) { lowestVal = avg; lowestCat = label; }
  }

  return { weekStart, weekEnd, endDay, daysInMonth, sameMonth, rows, company, topPerformer, incomplete, lowestCat, lowestVal, kpis,
    npMonth, ym, monthName: MONTH_NAME[Number(ym.slice(5, 7)) - 1], provisional };
}

// ---------- shared HTML pieces (email-safe: tables + inline styles) ----------
// Header icon tile — three bars built from table cells rather than an SVG or a
// remote PNG, so it renders identically in Outlook, Gmail and Apple Mail.
const heroTile = () => {
  const bar = (h: number) =>
    `<td width="4" valign="bottom" style="padding:0 2px;"><div style="width:4px;height:${h}px;background:#6ee7a7;border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td>`;
  // 12px, not C.rBox — matches the 40px .ws-head-ico tile on the site exactly.
  return `<table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" style="background:rgba(31,157,87,.20);border-radius:12px;"><tr><td align="center" valign="middle" height="40">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${bar(8)}${bar(16)}${bar(12)}</tr></table>
  </td></tr></table>`;
};

// `chipHtml` (optional) rides in the top-right of the hero — the manager report
// puts its store chip there.
// `npMonth` swaps the footer's goal-pace sentence — the goal a month is graded
// on is the only one the email may name.
const wrapEmail = (title: string, accent: string, range: string, body: string, chipHtml = '', npMonth = false) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media only screen and (max-width:520px){.gtile{display:block!important;width:100%!important;padding:6px 0!important}.pace-l,.pace-r{display:block!important;width:100%!important;text-align:left!important}.pace-r{padding-top:6px!important;font-size:24px!important}.pace-cap{font-size:12.5px!important;line-height:1.5!important}}</style></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:${C.rCard}px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:20px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="40" valign="top">${heroTile()}</td>
      <td valign="middle" style="padding-left:13px;">
        <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology</div>
        <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">${title}</div>
        <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">${range}</div>
      </td>
      ${chipHtml ? `<td align="right" valign="top">${chipHtml}</td>` : ''}
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:22px;">${body}</td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.footBg};">
    Generated automatically by Speeks · weekly figures are Mon–Sun. ${npMonth
      ? 'Goal pace is net profit from the Net Profit tab, month-to-date, projected over the days it has. Net profit = sales − cost − eBay fees − shipping − card fees − 7% royalty.'
      : 'Goal pace is gross profit, month-to-date through the report week.'}
  </td></tr>
</table></td></tr></table></body></html>`;

const sectionLabel = (t: string, note = '') =>
  `<div style="margin:26px 2px 12px;border-left:2px solid ${C.sage};padding-left:11px;">
     <div style="font-size:15.5px;font-weight:800;color:${C.charcoal};letter-spacing:-.015em;">${t}</div>
     ${note ? `<div style="font-size:11px;font-weight:600;color:${C.faint};margin-top:2px;">${note}</div>` : ''}
   </div>`;

const tile = (label: string, value: string, sub: string) =>
  `<td class="gtile" width="33%" valign="top" style="padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:${C.rBox}px;"><tr><td style="padding:14px;">
    <div style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;color:${C.faint};">${label}</div>
    <div style="font-size:23px;font-weight:900;color:${C.charcoal};margin-top:5px;">${value}</div>
    <div style="font-size:11px;font-weight:700;color:${C.muted};margin-top:3px;">${sub}</div>
  </td></tr></table></td>`;

const glanceRow = (d: any) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  ${tile('Buying', moneyK(d.boughtResale), `resale · <b style="color:${C.green}">${pct(d.buyMargin)}</b> margin · ${moneyK(d.boughtCash)} cash`)}
  ${tile('Selling', moneyK(d.soldRev), `revenue · <b style="color:${C.green}">${pct(d.gpMargin)}</b> GP (${moneyK(d.soldGp)})`)}
  ${tile('Listing Productivity', String(d.processed), `processed · <b style="color:${tgtColor(d.listingPct)}">${Math.round(d.listingPct)}%</b> of target`)}
</tr></table>`;

const paceBlock = (label: string, mtd: number, goal: number, proj: number) => {
  const banked = goal ? Math.min(100, (mtd / goal) * 100) : 0;
  const goalPct = goal ? (proj / goal) * 100 : 0;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;"><tr><td style="padding:16px;">
    <table role="presentation" width="100%"><tr>
      <td class="pace-l" style="font-size:13px;font-weight:800;color:${C.muted};vertical-align:middle;">${label}</td>
      <td class="pace-r" align="right" style="font-size:20px;font-weight:900;color:${C.charcoal};white-space:nowrap;vertical-align:middle;">${moneyK(mtd)} <span style="font-size:12px;color:${C.muted};">MTD</span></td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 8px;background:${C.track};border-radius:99px;"><tr><td style="background:${C.sage};height:12px;width:${banked}%;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>
    <div class="pace-cap" style="font-size:11.5px;font-weight:600;color:${C.muted};line-height:1.4;">${money(goal)} goal · ${Math.round(banked)}% banked · <b style="color:${goalPct >= 100 ? C.green : C.amber}">on pace for ${moneyK(proj)} — ${Math.round(goalPct)}% of goal</b></div>
  </td></tr></table>`;
};

const th = (t: string, align = 'center') => `<th style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};background:${C.soft};padding:9px 7px;text-align:${align};border-bottom:1px solid ${C.line};">${t}</th>`;
const badge = (s: string) => `<span style="display:inline-block;background:${STORE_TINT[s]};color:${STORE_COLOR[s]};border:1px solid ${STORE_RING[s]};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${s}</span>`;
const procCell = (count: number, p: number) => `<div style="font-weight:900;font-size:13px;color:${C.charcoal};">${count}</div><div style="font-size:9.5px;font-weight:800;color:${tgtColor(p)};">${Math.round(p)}% of tgt</div>`;

// rank badge (1st green … 5th red) + a labeled stat cell for the cash-flow summary
const rankColor = (rk: number) => rk === 1 ? C.green : rk === 2 ? '#2563eb' : rk >= 5 ? C.red : rk === 4 ? C.amber : C.muted;
// Tinted, not solid — a rank is metadata on a number, so it shouldn't outshout it.
const rankTint = (rk: number) => rk === 1 ? C.tint : rk === 2 ? '#e8f0fb' : rk >= 5 ? '#fcecec' : rk === 4 ? C.flagHead : '#f1f5f4';
const rankBadge = (rk: number) => `<span style="display:inline-block;font-size:9px;font-weight:800;color:${rankColor(rk)};background:${rankTint(rk)};border-radius:99px;padding:1px 6px;margin-left:5px;vertical-align:middle;">#${rk}</span>`;
const statCell = (label: string, value: string, rank?: number | null, valColor?: string) =>
  `<td width="33%" valign="top" style="padding:10px 13px;">
     <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};">${label}${rank != null ? rankBadge(rank) : ''}</div>
     <div style="font-size:18px;font-weight:900;color:${valColor || C.charcoal};margin-top:4px;">${value}</div>
   </td>`;

// Cash-flow summary: one Buying line + one Selling line. Shared by both reports.
// `ranks` (optional) adds #rank badges on Buy Value / Revenue / MTD GP (manager only).
function cashFlowSummary(r: any, ranks?: { buy?: number; rev?: number; gp?: number }) {
  const cogsSold = r.soldRev - r.soldGp;
  const banked = r.gpGoal ? Math.min(100, r.gpMtd / r.gpGoal * 100) : 0;
  const goalPct = r.gpGoal ? (r.gpProj / r.gpGoal) * 100 : 0;
  const channel = (title: string, cells: string, footer: string) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;border-collapse:collapse;margin-bottom:10px;overflow:hidden;">
      <tr><td colspan="3" style="padding:11px 14px 0;"><span style="font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.6px;color:${C.charcoal};">${title}</span></td></tr>
      <tr>${cells}</tr>
      ${footer ? `<tr><td colspan="3" style="padding:0 14px 13px;">${footer}</td></tr>` : '<tr><td colspan="3" style="padding:0 0 6px;"></td></tr>'}
    </table>`;
  const bar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:9px 0 0;background:${C.track};border-radius:99px;"><tr><td style="background:${C.sage};height:10px;width:${banked}%;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const buying = channel('Buying',
    statCell('Buy Value', money(r.boughtResale), ranks?.buy ?? null) +
    statCell('Cash Cost', money(r.boughtCash)) +
    statCell('Buy Margin', pct(r.buyMargin), null, buyColor(r.buyMargin)),
    '');
  if (r.npMonth) {
    // NP month: Revenue | Net Profit | Net Margin. No Gross Profit cell (Ethan
    // 2026-10-02: "ensure GP does not touch anything on this site anymore"). The
    // rank rides on Net Profit; the footer is MTD NP against the NP goal.
    const nb = r.npGoal ? Math.min(100, r.npMtd / r.npGoal * 100) : 0;
    const nBar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:9px 0 0;background:${C.track};border-radius:99px;"><tr><td style="background:${C.sage};height:10px;width:${nb}%;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
    const dash = `<span style="color:${C.faint};">—</span>`;
    const npVal = r.soldNp == null ? dash : money(r.soldNp);
    const nmVal = r.npMargin == null ? dash : pct(r.npMargin);
    const footer = r.npGoal
      ? `<div style="font-size:12px;font-weight:700;color:${C.charcoal};">MTD Net Profit ${money(r.npMtd)} <span style="color:${C.muted};font-weight:600;">of ${money(r.npGoal)} goal</span></div>${nBar}<div style="font-size:11px;font-weight:600;color:${C.muted};margin-top:5px;">${Math.round(nb)}% banked · ${r.npDays} day${r.npDays === 1 ? '' : 's'} in · tracking to <b style="color:${r.goalPct >= 100 ? C.green : C.amber};">${moneyK(r.npProj)} (${Math.round(r.goalPct)}% of goal)</b></div>`
      : `<div style="font-size:12px;font-weight:700;color:${C.charcoal};">MTD Net Profit ${money(r.npMtd)} <span style="color:${C.amber};font-weight:700;">· no NP goal set for this month</span></div>`;
    return buying + channel('Selling',
      statCell('Revenue', money(r.soldRev), ranks?.rev ?? null) +
      statCell('Net Profit', npVal, ranks?.gp ?? null) +
      statCell('Net Margin', nmVal),
      footer);
  }
  const selling = channel('Selling',
    statCell('Revenue', money(r.soldRev), ranks?.rev ?? null) +
    statCell('COGS', money(cogsSold)) +
    statCell('Sell Margin', pct(r.gpMargin), null, gpColor(r.gpMargin)),
    `<div style="font-size:12px;font-weight:700;color:${C.charcoal};">MTD Gross Profit ${money(r.gpMtd)} <span style="color:${C.muted};font-weight:600;">of ${money(r.gpGoal)} goal</span>${ranks?.gp != null ? rankBadge(ranks.gp) : ''}</div>${bar}<div style="font-size:11px;font-weight:600;color:${C.muted};margin-top:5px;">${Math.round(banked)}% banked · on pace for <b style="color:${goalPct >= 100 ? C.green : C.amber};">${moneyK(r.gpProj)} (${Math.round(goalPct)}% of goal)</b></div>`);
  return buying + selling;
}

function leaderboardTable(rows: Record<string, any>, company: any, youStore?: string) {
  const goalC = (p: number) => (p >= 100 ? C.green : p >= 85 ? C.amber : C.red);
  if (company.npMonth) return npLeaderboardTable(rows, company, goalC, youStore);
  const order = [...STORES].sort((a, b) => rows[b].soldGp - rows[a].soldGp);
  const body = order.map((s, i) => {
    const r = rows[s]; const you = s === youStore;
    return `<tr${you ? ` style="background:${C.tint};"` : ''}>
      <td style="padding:9px 6px;text-align:center;font-weight:900;color:${i === 0 ? C.gold : C.faint};">${i + 1}</td>
      <td style="padding:9px 6px;">${badge(s)}${you ? ` <span style="font-size:10px;font-weight:800;color:${C.sageDeep};background:${C.tint};border:1px solid #c6ecd6;padding:2px 6px;border-radius:6px;">YOU</span>` : ''}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:900;">${moneyK(r.soldGp)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;color:${gpColor(r.gpMargin)};">${pct(r.gpMargin)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;color:${goalC(r.goalPct)};">${Math.round(r.goalPct)}%</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;">${moneyK(r.soldRev)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;">${moneyK(r.boughtResale)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;color:${buyColor(r.buyMargin)};">${pct(r.buyMargin)}</td>
      <td style="padding:9px 6px;text-align:center;">${procCell(r.processed, r.listingPct)}</td>
    </tr>`;
  }).join('');
  const tc = `background:${C.soft};border-top:2px solid ${C.line};`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">
    <tr>${th('#')}${th('Store', 'left')}${th('GP$')}${th('GP%')}${th('% Goal')}${th('Sold')}${th('Bought')}${th('Buy%')}${th('Proc.')}</tr>
    ${body}
    <tr><td style="${tc}"></td>
      <td style="${tc}padding:10px 6px;font-weight:900;">Stores</td>
      <td style="${tc}text-align:center;font-weight:900;">${moneyK(company.soldGp)}</td>
      <td style="${tc}text-align:center;font-weight:900;color:${gpColor(company.gpMargin)};">${pct(company.gpMargin)}</td>
      <td style="${tc}text-align:center;font-weight:900;color:${goalC(company.goalPct)};">${Math.round(company.goalPct)}%</td>
      <td style="${tc}text-align:center;font-weight:900;">${moneyK(company.soldRev)}</td>
      <td style="${tc}text-align:center;font-weight:900;">${moneyK(company.boughtResale)}</td>
      <td style="${tc}text-align:center;font-weight:900;color:${buyColor(company.buyMargin)};">${pct(company.buyMargin)}</td>
      <td style="${tc}text-align:center;">${procCell(company.processed, company.listingPct)}</td>
    </tr>
  </table>`;
}

// NP-month leaderboard. Ranked on the WEEK's net profit (it is a weekly table);
// % Goal is the month's tracking against the NP goal. Kept a separate function
// rather than ternaries per cell so the GP table above stays exactly as it was.
// NP% is left uncoloured: there is no agreed NP-margin floor yet, and inventing
// one in an email to every store would make it policy by accident.
function npLeaderboardTable(rows: Record<string, any>, company: any, goalC: (p: number) => string, youStore?: string) {
  const order = [...STORES].sort((a, b) => (rows[b].soldNp ?? -1e12) - (rows[a].soldNp ?? -1e12));
  const npK = (v: number | null) => v == null ? `<span style="color:${C.faint};">—</span>` : moneyK(v);
  const npP = (v: number | null) => v == null ? `<span style="color:${C.faint};">—</span>` : pct(v);
  const gp = (p: number) => p > 0 ? `<span style="color:${goalC(p)};">${Math.round(p)}%</span>` : `<span style="color:${C.faint};">—</span>`;
  const body = order.map((s, i) => {
    const r = rows[s]; const you = s === youStore;
    return `<tr${you ? ` style="background:${C.tint};"` : ''}>
      <td style="padding:9px 6px;text-align:center;font-weight:900;color:${i === 0 ? C.gold : C.faint};">${i + 1}</td>
      <td style="padding:9px 6px;">${badge(s)}${you ? ` <span style="font-size:10px;font-weight:800;color:${C.sageDeep};background:${C.tint};border:1px solid #c6ecd6;padding:2px 6px;border-radius:6px;">YOU</span>` : ''}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:900;">${npK(r.soldNp)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;color:${C.muted};">${npP(r.npMargin)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;">${gp(r.npGoal ? r.goalPct : 0)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;">${moneyK(r.soldRev)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;">${moneyK(r.boughtResale)}</td>
      <td style="padding:9px 6px;text-align:center;font-weight:800;color:${buyColor(r.buyMargin)};">${pct(r.buyMargin)}</td>
      <td style="padding:9px 6px;text-align:center;">${procCell(r.processed, r.listingPct)}</td>
    </tr>`;
  }).join('');
  const tc = `background:${C.soft};border-top:2px solid ${C.line};`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">
    <tr>${th('#')}${th('Store', 'left')}${th('NP$')}${th('NP%')}${th('% Goal')}${th('Sold')}${th('Bought')}${th('Buy%')}${th('Proc.')}</tr>
    ${body}
    <tr><td style="${tc}"></td>
      <td style="${tc}padding:10px 6px;font-weight:900;">Stores</td>
      <td style="${tc}text-align:center;font-weight:900;">${npK(company.soldNp)}</td>
      <td style="${tc}text-align:center;font-weight:900;color:${C.muted};">${npP(company.npMargin)}</td>
      <td style="${tc}text-align:center;font-weight:900;">${gp(company.npGoal ? company.goalPct : 0)}</td>
      <td style="${tc}text-align:center;font-weight:900;">${moneyK(company.soldRev)}</td>
      <td style="${tc}text-align:center;font-weight:900;">${moneyK(company.boughtResale)}</td>
      <td style="${tc}text-align:center;font-weight:900;color:${buyColor(company.buyMargin)};">${pct(company.buyMargin)}</td>
      <td style="${tc}text-align:center;">${procCell(company.processed, company.listingPct)}</td>
    </tr>
  </table>`;
}

// "eBay Fees & Shipping" (was "Where the GP Went"; no GP column since 2026-10-02,
// when Ethan asked that GP be off everything) — MTD, per store, the two costs that a
// store can actually move: eBay fees and shipping, each as % of sales, beside
// the district's. Card fees and the 7% royalty are left out on purpose: card
// fees track sales mix, the royalty is a flat rate, and a column nobody can act
// on dilutes the two that matter. A cost more than LEAK_FLAG_PTS above the
// district prints RED with the gap in points, so it reads in a glance and
// survives clients that drop background colours. `youStore` tints the
// manager's own row the same way the leaderboard does.
function gpWentTable(d: any, youStore?: string) {
  const dl = d.company.leak;
  const cellP = (p: number | null, $: number, hi: boolean, gap: number | null) => {
    if (p == null) return `<span style="color:${C.faint};">—</span>`;
    const col = hi ? C.red : C.charcoal;
    return `<div style="font-weight:900;font-size:13px;color:${col};">${pct(p)}${hi ? ` <span style="font-size:10px;font-weight:900;">▲ +${gap!.toFixed(1)} pts</span>` : ''}</div>`
      // Whole dollars, not $k: early in a month a store's fees are a few hundred
      // dollars, and "$0.3k" says less than "$289".
      + `<div style="font-size:9.5px;font-weight:700;color:${hi ? C.red : C.faint};">${money($)}</div>`;
  };
  const pp = (p: number | null) => p == null ? `<span style="color:${C.faint};">—</span>` : pct(p);
  const order = [...STORES].sort((a, b) => (d.rows[b].leak?.sales ?? 0) - (d.rows[a].leak?.sales ?? 0));
  const body = order.map((s) => {
    const l = d.rows[s].leak; const you = s === youStore;
    if (!l) return '';
    const hi = l.ebayHi || l.shipHi;
    return `<tr${you ? ` style="background:${C.tint};"` : hi ? ` style="background:#fdf6f6;"` : ''}>
      <td style="padding:9px 7px;border-bottom:1px solid ${C.line2};">${badge(s)}</td>
      <td style="padding:9px 7px;text-align:center;font-weight:800;border-bottom:1px solid ${C.line2};">${moneyK(l.sales)}</td>
      <td style="padding:9px 7px;text-align:center;border-bottom:1px solid ${C.line2};">${cellP(l.ebayPct, l.ebay, l.ebayHi, l.ebayGap)}</td>
      <td style="padding:9px 7px;text-align:center;border-bottom:1px solid ${C.line2};">${cellP(l.shipPct, l.ship, l.shipHi, l.shipGap)}</td>
      <td style="padding:9px 7px;text-align:center;font-weight:900;border-bottom:1px solid ${C.line2};">${pp(l.npPct)}</td>
    </tr>`;
  }).join('');
  const tc = `background:${C.soft};border-top:2px solid ${C.line};`;
  const flagged = STORES.filter(s => d.rows[s].leak && (d.rows[s].leak.ebayHi || d.rows[s].leak.shipHi));
  const note = flagged.length
    ? `<tr><td colspan="5" style="padding:10px 12px;font-size:11.5px;font-weight:700;color:${C.red};">${flagged.map(s => {
        const l = d.rows[s].leak; const parts: string[] = [];
        if (l.ebayHi) parts.push(`eBay fees ${pct(l.ebayPct)} vs ${pct(dl.ebayPct)}`);
        if (l.shipHi) parts.push(`shipping ${pct(l.shipPct)} vs ${pct(dl.shipPct)}`);
        return `${s}: ${parts.join(' · ')}`;
      }).join('<br>')}</td></tr>`
    : `<tr><td colspan="5" style="padding:10px 12px;font-size:11.5px;font-weight:600;color:${C.muted};">No store more than ${LEAK_FLAG_PTS.toFixed(1)} pt above the district on eBay fees or shipping.</td></tr>`;
  const prov = d.provisional.length
    ? `<tr><td colspan="5" style="padding:0 12px 10px;font-size:10.5px;font-weight:600;color:${C.faint};">Shipping isn't final for ${d.provisional.map((x: string) => fmtMD(parseYMD(x))).join(', ')} (it lands at 2pm the next day) — those days are left out of the shipping %, and their net profit may still come down.</td></tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">
    <tr>${th('Store', 'left')}${th('Sales MTD')}${th('eBay Fees')}${th('Shipping')}${th('NP%')}</tr>
    ${body}
    <tr><td style="${tc}padding:10px 7px;font-weight:900;">District</td>
      <td style="${tc}text-align:center;font-weight:900;">${moneyK(dl.sales)}</td>
      <td style="${tc}text-align:center;">${cellP(dl.ebayPct, dl.ebay, false, null)}</td>
      <td style="${tc}text-align:center;">${cellP(dl.shipPct, dl.ship, false, null)}</td>
      <td style="${tc}text-align:center;font-weight:900;">${pp(dl.npPct)}</td>
    </tr>
    ${note}${prov}
  </table>`;
}

function buyingTable(rows: Record<string, any>, company: any) {
  const order = [...STORES].sort((a, b) => rows[b].boughtResale - rows[a].boughtResale);
  const body = order.map((s, i) => {
    const r = rows[s];
    return `<tr>
      <td style="padding:10px 7px;text-align:center;font-weight:900;color:${i === 0 ? C.gold : C.faint};">${i + 1}</td>
      <td style="padding:10px 7px;">${badge(s)}</td>
      <td style="padding:10px 7px;text-align:center;font-weight:800;">${money(r.boughtResale)}</td>
      <td style="padding:10px 7px;text-align:center;font-weight:800;">${money(r.boughtCash)}</td>
      <td style="padding:10px 7px;text-align:center;font-weight:800;color:${buyColor(r.buyMargin)};">${pct(r.buyMargin)}</td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">
    <tr>${th('#')}${th('Store', 'left')}${th('Resale Value')}${th('Cash Paid')}${th('Buy Margin')}</tr>${body}
    <tr><td style="background:${C.soft};border-top:2px solid ${C.line};"></td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};padding:10px 7px;font-weight:900;">Stores</td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};text-align:center;font-weight:900;">${money(company.boughtResale)}</td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};text-align:center;font-weight:900;">${money(company.boughtCash)}</td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};text-align:center;font-weight:900;color:${buyColor(company.buyMargin)};">${pct(company.buyMargin)}</td>
    </tr></table>`;
}

function listingTable(rows: Record<string, any>, company: any) {
  const order = [...STORES].sort((a, b) => rows[b].listingPct - rows[a].listingPct);
  const body = order.map((s, i) => {
    const r = rows[s];
    return `<tr>
      <td style="padding:10px 7px;text-align:center;font-weight:900;color:${i === 0 ? C.gold : C.faint};">${i + 1}</td>
      <td style="padding:10px 7px;">${badge(s)}</td>
      <td style="padding:10px 7px;text-align:center;">${procCell(r.processed, r.listingPct)}</td>
      <td style="padding:10px 7px;text-align:center;font-weight:800;">${moneyK(r.retail)}</td>
      <td style="padding:10px 7px;text-align:center;font-weight:800;color:${r.listedMargin >= 55 ? C.green : C.amber};">${pct(r.listedMargin)}</td>
      <td style="padding:10px 7px;text-align:center;font-weight:800;">${pct(r.pctSold)}</td>
    </tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">
    <tr>${th('#')}${th('Store', 'left')}${th('Processed')}${th('Retail $')}${th('Margin')}${th('% Sold')}</tr>${body}
    <tr><td style="background:${C.soft};border-top:2px solid ${C.line};"></td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};padding:10px 7px;font-weight:900;">Stores</td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};text-align:center;">${procCell(company.processed, company.listingPct)}</td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};text-align:center;font-weight:900;">${moneyK(company.retail)}</td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};text-align:center;font-weight:900;color:${company.listedMargin >= 55 ? C.green : C.amber};">${pct(company.listedMargin)}</td>
      <td style="background:${C.soft};border-top:2px solid ${C.line};text-align:center;font-weight:900;">${pct(company.pctSold)}</td>
    </tr></table>`;
}

const chip = (text: string, kind: 'bad' | 'warn' | 'ok') => {
  const m = {
    bad:  ['#fcecec', '#b23636', '#f6d5d5'],
    warn: [C.flagHead, C.flagInk, C.flagBorder],
    ok:   [C.tint, '#146c3c', '#c6ecd6'],
  }[kind];
  return `<span style="display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:99px;background:${m[0]};color:${m[1]};border:1px solid ${m[2]};margin:3px 4px 0 0;">${text}</span>`;
};

function flagsBlock(d: any) {
  const items: string[] = [];
  // any 0/10 scorecard categories across stores — immediate attention, listed first
  const zeros: string[] = [];
  for (const s of STORES) {
    if (!d.rows[s].card) continue;
    for (const [k, label] of SCORECARD_CATS) {
      const cv = cardVal(d.rows[s].card, k);
      if (cv != null && n(cv) * 2 === 0) zeros.push(`${s} — ${label}`);
    }
  }
  if (zeros.length) items.push(`<div style="padding:11px 14px;border-bottom:1px solid ${C.flagRule};"><div style="font-size:13px;font-weight:900;color:${C.red};">${zeros.length} categor${zeros.length === 1 ? 'y' : 'ies'} scored 0/10 — immediate attention</div><div>${zeros.map(z => chip(z, 'bad')).join('')}</div></div>`);
  // listing target
  const under = STORES.filter(s => d.rows[s].listingPct < 100);
  if (under.length) {
    // A copy: a bare STORES.sort() here reordered the global for every later
    // section and every manager email in the same run.
    const chips = [...STORES].sort((a, b) => d.rows[a].listingPct - d.rows[b].listingPct)
      .map(s => chip(`${s} ${Math.round(d.rows[s].listingPct)}%`, d.rows[s].listingPct >= 100 ? 'ok' : d.rows[s].listingPct >= 80 ? 'warn' : 'bad')).join('');
    items.push(`<div style="padding:11px 14px;border-bottom:1px solid ${C.flagRule};"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">Listings — ${Math.round(d.company.listingPct)}% of target</div><div style="font-size:11.5px;color:${C.muted};font-weight:600;">${under.length} of 5 stores under goal</div><div>${chips}</div></div>`);
  }
  // NP months: eBay fees / shipping over the district (see gpWentTable). Listed
  // high in the block — it is the cost the CEO asked to have called out.
  if (d.npMonth && d.company.leak) {
    const hi: string[] = [];
    for (const s of STORES) {
      const l = d.rows[s].leak; if (!l) continue;
      if (l.ebayHi) hi.push(chip(`${s} eBay ${pct(l.ebayPct)} (+${l.ebayGap.toFixed(1)})`, 'bad'));
      if (l.shipHi) hi.push(chip(`${s} shipping ${pct(l.shipPct)} (+${l.shipGap.toFixed(1)})`, 'bad'));
    }
    if (hi.length) items.push(`<div style="padding:11px 14px;border-bottom:1px solid ${C.flagRule};"><div style="font-size:13px;font-weight:900;color:${C.red};">eBay fees / shipping over the district</div><div style="font-size:11.5px;color:${C.muted};font-weight:600;">MTD % of sales · district eBay ${pct(d.company.leak.ebayPct ?? 0)} · shipping ${pct(d.company.leak.shipPct ?? 0)} · flag at +${LEAK_FLAG_PTS.toFixed(1)} pt</div><div>${hi.join('')}</div></div>`);
  }
  // buy margin
  const lowBuy = STORES.filter(s => d.rows[s].buyMargin < 51);
  if (lowBuy.length) {
    items.push(`<div style="padding:11px 14px;border-bottom:1px solid ${C.flagRule};"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">Buy margin under 51% floor</div><div>${lowBuy.map(s => chip(`${s} ${pct(d.rows[s].buyMargin)}`, 'bad')).join('')}</div></div>`);
  }
  // scorecard lowest
  if (d.lowestCat) items.push(`<div style="padding:11px 14px;border-bottom:1px solid ${C.flagRule};"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">${esc(d.lowestCat)} is the lowest scorecard category</div><div style="font-size:11.5px;color:${C.muted};font-weight:600;">Company average ${d.lowestVal.toFixed(1)}/10</div></div>`);
  // practice audit below the 80% pass line
  const failAudit = STORES.filter(s => d.rows[s].audit && d.rows[s].audit.pct < 80);
  if (failAudit.length) {
    items.push(`<div style="padding:11px 14px;border-bottom:1px solid ${C.flagRule};"><div style="font-size:13px;font-weight:900;color:${C.red};">${failAudit.length} store${failAudit.length === 1 ? '' : 's'} below the 80% audit pass line</div><div style="font-size:11.5px;color:${C.muted};font-weight:600;">target is 90%+</div><div>${failAudit.map(s => chip(`${s} ${d.rows[s].audit.pct}%`, 'bad')).join('')}</div></div>`);
  }
  // incomplete kpi
  if (d.incomplete.length) items.push(`<div style="padding:11px 14px;"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">${d.incomplete.length} incomplete KPI ${d.incomplete.length === 1 ? 'entry' : 'entries'}</div><div>${d.incomplete.map((x: any) => chip(`${esc(x.name)} · ${x.store} — ${x.what}`, 'warn')).join('')}</div></div>`);
  if (!items.length) items.push(`<div style="padding:11px 14px;font-size:12.5px;color:${C.muted};">No flags this week.</div>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.flagBorder};background:${C.flagBg};border-radius:${C.rBox}px;overflow:hidden;"><tr><td style="background:${C.flagHead};padding:9px 14px;font-size:12px;font-weight:900;color:${C.flagInk};text-transform:uppercase;letter-spacing:.5px;">Live flags this week</td></tr><tr><td>${items.join('')}</td></tr></table>`;
}

function rowsBox(rowsHtml: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;">${rowsHtml}</table>`;
}

// ---------- leadership email ----------
function buildLeadership(d: any) {
  const range = `${fmtMD(d.weekStart)} – ${fmtMD(d.weekEnd)}, ${d.weekEnd.getFullYear()} · All Stores`;
  const tp = d.topPerformer;
  const tpConv = tp && n(tp.transaction_count) ? Math.round(100 * n(tp.transaction_converted) / n(tp.transaction_count)) : null;
  const kpiCount = STORES.filter(s => d.rows[s].kpiSubmitted).length;

  // per-store score table — Online & Marketing /10 + PayMore practice Audit %
  const tpRow = tp
    ? `<tr><td colspan="4" style="padding:11px 14px;border-bottom:1px solid ${C.line2};background:${C.tint};"><span style="font-size:9.5px;font-weight:800;color:${C.sageDeep};background:${C.tint};border:1px solid #c6ecd6;padding:3px 8px;border-radius:99px;">TOP PERFORMER</span> <b style="color:${C.charcoal};">${esc(tp.employee_name)} · ${tp.store}</b> <span style="color:${C.muted};font-size:11px;">${n(tp.listed_count)} processed${tpConv != null ? ` · ${tpConv}% conversion` : ''}</span></td></tr>`
    : '';
  // ranked by practice-audit % (stores without an audit fall to the bottom)
  const scoreOrder = [...STORES].sort((a, b) => (d.rows[b].audit ? d.rows[b].audit.pct : -1) - (d.rows[a].audit ? d.rows[a].audit.pct : -1));
  const scoreRows = scoreOrder.map((s, i) => {
    const r = d.rows[s];
    const sc = r.card ? n(r.card.store_average) * 2 : null;
    const scStr = sc == null
      ? `<span style="color:${C.faint};">—</span>`
      : `<span style="color:${scoreColor(sc)};font-weight:900;">${sc.toFixed(1)}</span><span style="color:${C.faint};font-size:11px;font-weight:700;margin-left:5px;">/ 10</span>`;
    const a = r.audit;
    const aCol = a ? (a.pct >= 90 ? C.green : a.pct >= 80 ? C.amber : C.red) : C.faint;
    const aStr = a
      ? `<span style="color:${aCol};font-weight:900;">${a.pct}%</span><span style="color:${C.faint};font-size:10.5px;font-weight:700;margin-left:10px;">${a.earned} / ${a.possible}</span>`
      : `<span style="color:${C.faint};">—</span>`;
    return `<tr>
      <td style="padding:12px 10px;text-align:center;font-weight:900;color:${i === 0 ? C.gold : C.faint};border-bottom:1px solid ${C.line2};">${i + 1}</td>
      <td style="padding:12px 14px;border-bottom:1px solid ${C.line2};">${badge(s)}</td>
      <td style="padding:12px 18px;text-align:center;border-bottom:1px solid ${C.line2};font-size:16px;white-space:nowrap;">${scStr}</td>
      <td style="padding:12px 18px;text-align:center;border-bottom:1px solid ${C.line2};font-size:16px;white-space:nowrap;">${aStr}</td>
    </tr>`;
  }).join('');
  const scoreBox = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">
    ${tpRow}
    <tr>${th('#')}${th('Store', 'left')}${th('Scorecard')}${th('PayMore Audit')}</tr>
    ${scoreRows}
  </table>`;

  const body = `
  ${sectionLabel('Cash Flow Summary', 'all stores combined')}
  ${cashFlowSummary(d.company)}
  ${sectionLabel('Store Leaderboard', d.npMonth ? `ranked by weekly net profit · % goal is ${d.monthName} NP tracking` : 'ranked by weekly gross profit')}
  ${leaderboardTable(d.rows, d.company)}
  ${d.npMonth ? sectionLabel('eBay Fees &amp; Shipping', `${d.monthName} to date · eBay fees and shipping as % of sales · red = over ${LEAK_FLAG_PTS.toFixed(1)} pt above the district`) + gpWentTable(d) : ''}
  ${sectionLabel('Buying Breakdown', 'ranked by volume bought · resale value vs cash paid')}
  ${buyingTable(d.rows, d.company)}
  ${sectionLabel('Listing Productivity by Store', 'ranked by % of target')}
  ${listingTable(d.rows, d.company)}
  ${sectionLabel('Needs Attention')}
  ${flagsBlock(d)}
  ${sectionLabel('Store Scores', 'ranked by audit · targets 8.0+ and 90%+')}
  ${scoreBox}
  ${sectionLabel('Ops Compliance')}
  ${rowsBox(`<tr><td style="padding:11px 14px;border-bottom:1px solid ${C.line2};font-size:12.5px;"><b>Weekly KPIs submitted</b> <span style="float:right;font-weight:900;color:${kpiCount === 5 ? C.green : C.amber};">${kpiCount} / 5</span></td></tr><tr><td style="padding:11px 14px;font-size:12.5px;"><b>Audit Readiness</b> <span style="color:${C.faint};font-weight:600;">weekly % · daily avg % (Mon–Sun)</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${STORES.map(s => {
      const w = d.rows[s].auditWeeklyPct, da = d.rows[s].auditDailyPct;
      const ac = (p: number | null) => p == null ? C.faint : p >= 80 ? C.green : p >= 50 ? C.amber : C.red;
      const fmt = (p: number | null) => p == null ? '—' : Math.round(p) + '%';
      return `<tr><td style="padding:3px 0;">${badge(s)}</td><td align="right" style="font-weight:800;color:${ac(w)};">Weekly ${fmt(w)}</td><td align="right" style="font-weight:800;color:${ac(da)};padding-left:16px;">Daily ${fmt(da)}</td></tr>`;
    }).join('')}</table></td></tr>`)}
  `;
  return wrapEmail('Weekly Performance Report', C.sage, range, body, '', d.npMonth);
}

// ---------- manager email ----------
function buildManager(d: any, store: string) {
  const r = d.rows[store];
  const range = `${fmtMD(d.weekStart)} – ${fmtMD(d.weekEnd)}, ${d.weekEnd.getFullYear()} · ${STORE_NAME[store]} (${store})`;
  const avg = r.card ? (n(r.card.store_average) * 2).toFixed(1) : '—';

  // rank this store against the others for each major KPI
  const rankOf = (m: (x: any) => number) => {
    const sorted = [...STORES].sort((a, b) => m(d.rows[b]) - m(d.rows[a]));
    return sorted.indexOf(store) + 1;
  };
  // NP months rank on the week's net profit (the leaderboard's order); the
  // badge then rides on the Net Profit cell rather than the MTD GP line.
  const gpRank = d.npMonth ? rankOf(x => x.soldNp ?? -1e12) : rankOf(x => x.soldGp);
  const revRank = rankOf(x => x.soldRev);
  const buyRank = rankOf(x => x.boughtResale);
  const listRank = rankOf(x => x.listingPct);
  const scoreRank = rankOf(x => x.card ? n(x.card.store_average) : -1);
  const auditRank = rankOf(x => x.audit ? x.audit.pct : -1);

  // Header card: store identity + Scorecard / Listing / Audit (each ranked).
  // Airy V4 — the store colour is a 3px keyline plus the chip rather than a
  // full-bleed panel, which used to fight every section beneath it. The ground
  // matches the email hero so the two read as one masthead.
  const UNIT = 'font-size:12px;font-weight:700;color:rgba(255,255,255,.60);';
  const headTile = (label: string, rank: number, value: string, valColor = '#ffffff') =>
    `<td width="50%" valign="top" style="padding:4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.10);border-radius:${C.rBox}px;"><tr><td style="padding:11px 13px;">
      <div style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,.60);">${label}${rank > 0 ? rankBadge(rank) : ''}</div>
      <div style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:${valColor};margin-top:3px;">${value}</div>
    </td></tr></table></td>`;
  const passTile = !r.audit
    ? headTile('Audit Pass', 0, '—')
    : r.audit.pct >= 80
      ? headTile('Audit Pass', 0, `<span style="font-size:14px;font-weight:800;">${r.audit.pct >= 90 ? 'On target ✓' : 'Passing'}</span>`, '#6ee7a7')
      : headTile('Audit Pass', 0, '<span style="font-size:14px;font-weight:800;">Below 80%</span>', '#ff9d9d');
  const headerCard = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#13181a;border-radius:${C.rBox}px;overflow:hidden;">
    <tr><td style="height:3px;background:${STORE_COLOR[store]};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:16px 16px 14px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td>${badge(store)}</td>
      <td style="padding-left:9px;font-size:19px;font-weight:800;letter-spacing:-.02em;color:#ffffff;">${STORE_NAME[store]}</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:9px;">
      <tr>
        ${headTile('Scorecard', r.card ? scoreRank : 0, r.card ? `${avg}<span style="${UNIT}">/10</span>` : '—')}
        ${headTile('Listing Prod.', listRank, `${Math.round(r.listingPct)}<span style="${UNIT}">% goal</span>`)}
      </tr>
      <tr>
        ${headTile('PayMore Audit', r.audit ? auditRank : 0, r.audit ? `${r.audit.pct}<span style="${UNIT}">%</span>` : '—')}
        ${passTile}
      </tr>
    </table>
  </td></tr></table>`;

  // team listing rows + Team Total
  const teamK = d.kpis.filter((k: any) => k.store === store).sort((a: any, b: any) => n(b.listed_count) - n(a.listed_count));
  const teamRows = teamK.map((k: any, i: number) => {
    const inc = (k.listed_retail_price == null || k.listed_cost == null);
    const retail = inc ? '—' : money(n(k.listed_retail_price));
    const lmv = n(k.listed_retail_price) ? (n(k.listed_retail_price) - n(k.listed_cost)) / n(k.listed_retail_price) * 100 : 0;
    const lm = inc ? '—' : `<span style="color:${lmv >= 55 ? C.green : C.amber};">${pct(lmv)}</span>`;
    const ps = inc ? '—' : pct(n(k.listed_retail_price) ? n(k.listed_sold_value) / n(k.listed_retail_price) * 100 : 0);
    return `<tr${inc ? ` style="background:${C.flagBg};"` : ''}>
      <td style="padding:9px 7px;font-weight:800;">${i === 0 ? `<span style="font-size:9px;font-weight:800;color:${C.sageDeep};background:${C.tint};border:1px solid #c6ecd6;padding:1px 6px;border-radius:99px;margin-right:5px;">TOP</span>` : ''}${esc(k.employee_name)}${inc ? ` <span style="font-size:9px;font-weight:800;color:${C.flagInk};background:${C.flagHead};border:1px solid ${C.flagBorder};border-radius:99px;padding:1px 7px;">incomplete KPI</span>` : ''}</td>
      <td style="padding:9px 7px;text-align:center;font-weight:800;">${n(k.listed_count)}</td>
      <td style="padding:9px 7px;text-align:center;font-weight:800;">${retail}</td>
      <td style="padding:9px 7px;text-align:center;font-weight:800;">${lm}</td>
      <td style="padding:9px 7px;text-align:center;font-weight:800;">${ps}</td>
    </tr>`;
  }).join('');
  const tt = `border-top:2px solid ${C.line};background:${C.soft};`;
  const teamTotal = `<tr>
    <td style="padding:10px 7px;font-weight:900;${tt}">Team Total</td>
    <td style="padding:10px 7px;text-align:center;font-weight:900;${tt}">${r.processed}</td>
    <td style="padding:10px 7px;text-align:center;font-weight:900;${tt}">${money(r.retail)}</td>
    <td style="padding:10px 7px;text-align:center;font-weight:900;${tt}color:${r.listedMargin >= 55 ? C.green : C.amber};">${pct(r.listedMargin)}</td>
    <td style="padding:10px 7px;text-align:center;font-weight:900;${tt}">${pct(r.pctSold)}</td></tr>`;

  // scorecard (scored cats, worst first) + Store Average total
  const scoredCats = r.card
    ? SCORECARD_CATS.map(([k, label]) => {
        const cv = cardVal(r.card, k);
        return { label, v: cv == null ? null : n(cv) * 2 };
      }).filter(x => x.v != null).sort((a, b) => (a.v as number) - (b.v as number))
    : [];
  let scoreHtml = `<tr><td colspan="2" style="padding:11px 14px;color:${C.muted};font-size:12px;">No scorecard on file for this period.</td></tr>`;
  if (r.card) {
    scoreHtml = scoredCats.map(x => {
      const v = x.v as number;
      return `<tr><td style="padding:8px 14px;font-weight:700;color:${C.charcoal};font-size:12px;border-bottom:1px solid ${C.line2};width:70%;">${x.label}</td>
        <td style="padding:8px 14px;text-align:right;font-weight:900;color:${scoreColor(v)};border-bottom:1px solid ${C.line2};">${v}</td></tr>`;
    }).join('') +
      `<tr><td style="padding:10px 14px;font-weight:900;color:${C.charcoal};font-size:13px;${tt}">Store Average</td>
        <td style="padding:10px 14px;text-align:right;font-weight:900;font-size:14px;color:${scoreColor(n(r.card.store_average) * 2)};${tt}">${avg}/10</td></tr>`;
  }

  // PayMore practice-audit section: overall score + per-section subtotals (where points were lost)
  let auditHtml = `<tr><td colspan="2" style="padding:11px 14px;color:${C.muted};font-size:12px;">No practice audit on file for this period.</td></tr>`;
  if (r.audit) {
    const aCol = r.audit.pct >= 90 ? C.green : (r.audit.pct >= 80 ? C.amber : C.red);
    const secs = auditSectionBreakdown(r.audit.results);
    auditHtml = secs.map(sec => {
      const full = sec.earned === sec.total;
      const col = full ? C.green : (sec.earned > 0 ? C.amber : C.red);
      return `<tr><td style="padding:8px 14px;font-weight:700;color:${C.charcoal};font-size:12px;border-bottom:1px solid ${C.line2};width:70%;">${sec.title}</td>
        <td style="padding:8px 14px;text-align:right;font-weight:900;color:${col};border-bottom:1px solid ${C.line2};">${sec.earned}/${sec.total}</td></tr>`;
    }).join('') +
      `<tr><td style="padding:10px 14px;font-weight:900;color:${C.charcoal};font-size:13px;${tt}">Audit Score</td>
        <td style="padding:10px 14px;text-align:right;font-weight:900;font-size:14px;color:${aCol};${tt}">${r.audit.earned}/${r.audit.possible} · ${r.audit.pct}%</td></tr>`;
  }

  // focus — every 0/10 first (immediate), then the lowest, then listings + buying strength
  const focus: string[] = [];
  scoredCats.filter(x => x.v === 0).forEach(z => focus.push(`<span style="color:${C.red};">●</span> <b>${z.label} scored 0/10</b> — needs immediate attention.`));
  if (r.audit && r.audit.pct < 80) focus.push(`<span style="color:${C.red};">●</span> <b>PayMore audit ${r.audit.pct}%</b> — below the 80% pass line (target 90%+). Review the missed items on your dashboard.`);
  else if (r.audit && r.audit.pct < 90) focus.push(`<span style="color:${C.amber};">●</span> <b>PayMore audit ${r.audit.pct}%</b> — passing, but push for the 90%+ target.`);
  const worst = scoredCats[0];
  if (worst && (worst.v as number) > 0 && (worst.v as number) < 8) focus.push(`<span style="color:${C.amber};">●</span> <b>${worst.label} scored ${worst.v}/10</b> — your lowest scored category.`);
  if (r.listingPct < 100) focus.push(`<span style="color:${C.red};">●</span> <b>Listings ${Math.round(r.listingPct)}% of target</b> (${r.target - r.processed} short) — push processing volume.`);
  // NP months: eBay fees / shipping over the district, in red, with the gap in
  // points and what it cost — the CEO/DM ask is that a store sees this itself.
  if (d.npMonth && r.leak) {
    const dl = d.company.leak;
    if (r.leak.ebayHi) focus.push(`<span style="color:${C.red};">●</span> <b style="color:${C.red};">eBay fees ${pct(r.leak.ebayPct)} of sales</b> — ${r.leak.ebayGap.toFixed(1)} pts above the district's ${pct(dl.ebayPct)} (${money(r.leak.ebay)} ${d.monthName} to date).`);
    if (r.leak.shipHi) focus.push(`<span style="color:${C.red};">●</span> <b style="color:${C.red};">Shipping ${pct(r.leak.shipPct)} of sales</b> — ${r.leak.shipGap.toFixed(1)} pts above the district's ${pct(dl.shipPct)} (${money(r.leak.ship)} ${d.monthName} to date).`);
  }
  if (r.buyMargin >= 51) focus.push(`<span style="color:${C.green};">●</span> <b>Buy margin ${pct(r.buyMargin)}</b> — keep the buying discipline up.`);

  const body = `
  ${headerCard}
  ${sectionLabel('Cash Flow Summary')}
  ${cashFlowSummary(r, { buy: buyRank, rev: revRank, gp: gpRank })}
  ${sectionLabel('Where You Stand', d.npMonth ? `all stores this week · ranked by net profit · % goal is ${d.monthName} NP tracking` : 'all stores this week · ranked by gross profit')}
  ${leaderboardTable(d.rows, d.company, store)}
  ${d.npMonth ? sectionLabel('eBay Fees &amp; Shipping', `${d.monthName} to date · your eBay fees and shipping vs the district · red = over ${LEAK_FLAG_PTS.toFixed(1)} pt above`) + gpWentTable(d, store) : ''}
  ${sectionLabel('Listing Productivity', `${r.processed} of ${r.target} target · ${Math.round(r.listingPct)}%`)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;border-collapse:separate;">
    <tr>${th('Lister', 'left')}${th('Listed')}${th('Retail $')}${th('Margin')}${th('% Sold')}</tr>${teamRows}${teamTotal}
  </table>
  ${sectionLabel('Scorecard', r.card ? `Online & Marketing · ${avg}/10` : '')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;">${scoreHtml}</table>
  ${sectionLabel('PayMore Audit', r.audit ? `${r.audit.earned}/${r.audit.possible} · ${r.audit.pct}% · pass 80% · target 90%+` : '')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;">${auditHtml}</table>
  ${focus.length ? sectionLabel('Focus This Week') + rowsBox(focus.map(f => `<tr><td style="padding:10px 14px;font-size:12.5px;border-bottom:1px solid ${C.line2};">${f}</td></tr>`).join('')) : ''}
  `;
  return wrapEmail('Your Weekly Report', C.sage, range, body, badge(store), d.npMonth);
}

// ---------- send (Gmail relay preferred, Resend fallback) ----------
async function sendEmail(to: string[], subject: string, html: string) {
  // Gmail relay: a tiny Apps Script web app that sends via GmailApp. No DNS.
  const relay = GMAIL_RELAY;
  if (relay) {
    const res = await fetch(relay, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ secret: SECRET, to: to.join(','), subject, html }),
    });
    const txt = await res.text();
    return { ok: res.ok, status: res.status, body: txt.slice(0, 300) };
  }
  // Fallback: Resend (needs verified domain).
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return { ok: false, error: 'No GMAIL_RELAY_URL or RESEND_API_KEY set' };
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: txt.slice(0, 300) };
}

// ---------- snapshot persistence ----------
// NP months: the gp_* columns stay GROSS profit (MTD GP off daily_np), and
// gp_goal / goal_pct are written 0 — there is no GP goal in an NP month, and
// the NP goal % in a column that sits beside GP figures would make the history
// lie. 0, not NULL: it is what a month with no goal has always written, and the
// table's DDL is not in the repo to say NULL is allowed. The table has no NP
// columns yet; adding them is a migration.
async function writeSnapshots(sb: any, d: any) {
  const weekEnd = ymd(d.weekEnd);
  const recs = STORES.map(s => {
    const r = d.rows[s];
    return {
      week_end: weekEnd, store: s, bought_resale: r.boughtResale, bought_cash: r.boughtCash, buy_margin_pct: r.buyMargin,
      sold_revenue: r.soldRev, sold_gp: r.soldGp, gp_margin_pct: r.gpMargin, processed: r.processed, listing_target: r.target,
      listing_pct: r.listingPct, retail_value: r.retail, listed_margin_pct: r.listedMargin, pct_sold: r.pctSold,
      gp_mtd: r.gpMtd, gp_goal: d.npMonth ? 0 : r.gpGoal, gp_proj: r.gpProj, goal_pct: d.npMonth ? 0 : r.goalPct,
      scorecard_avg: r.card ? n(r.card.store_average) * 2 : null,
      audit_pct: r.audit ? r.audit.pct : null,
      audit_earned: r.audit ? r.audit.earned : null,
    };
  });
  recs.push({
    week_end: weekEnd, store: 'ALL', bought_resale: d.company.boughtResale, bought_cash: d.company.boughtCash, buy_margin_pct: d.company.buyMargin,
    sold_revenue: d.company.soldRev, sold_gp: d.company.soldGp, gp_margin_pct: d.company.gpMargin, processed: d.company.processed,
    listing_target: d.company.target, listing_pct: d.company.listingPct, retail_value: d.company.retail, listed_margin_pct: d.company.listedMargin,
    pct_sold: d.company.pctSold, gp_mtd: d.company.gpMtd, gp_goal: d.npMonth ? 0 : d.company.gpGoal, gp_proj: d.company.gpProj, goal_pct: d.npMonth ? 0 : d.company.goalPct, scorecard_avg: null,
    audit_pct: null, audit_earned: null,
  } as any);
  await sb.from('weekly_report_snapshots').upsert(recs, { onConflict: 'week_end,store' });
}

// ---------- handler ----------
Deno.serve(async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  if (q('secret') !== SECRET) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors });

  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    await loadReportCatalogs(sb);
    await loadRecipients(sb);
    const weekEnd = q('weekEnd') ? parseYMD(q('weekEnd')!) : lastSundayCentral();
    const types = (q('types') || 'both').toLowerCase();
    const overrideTo = q('to');                       // test: send everything here
    const onlyStores = q('stores') ? q('stores')!.toUpperCase().split(',') : STORES;
    const dryRun = q('dryRun') === '1';

    const d = await gather(sb, weekEnd);
    const rangeLabel = `${fmtMD(d.weekStart)}–${fmtMD(d.weekEnd)}`;
    const sent: any[] = [];

    if (dryRun) {
      const which = q('preview') === 'manager' ? buildManager(d, (onlyStores[0] || 'BAL')) : buildLeadership(d);
      return new Response(which, { headers: { 'Content-Type': 'text/html' } });
    }

    if (types === 'both' || types === 'leadership') {
      const html = buildLeadership(d);
      const to = overrideTo ? [overrideTo] : LEADERSHIP_TO;
      sent.push({ report: 'leadership', to, ...(await sendEmail(to, `Speeks Weekly Report — ${rangeLabel}`, html)) });
    }
    if (types === 'both' || types === 'manager') {
      for (const s of onlyStores) {
        if (!STORES.includes(s)) continue;
        const html = buildManager(d, s);
        const to = overrideTo ? [overrideTo] : (STORE_TO[s]?.length ? STORE_TO[s] : [DEFAULT_TO]);
        sent.push({ report: `manager:${s}`, to, ...(await sendEmail(to, `${STORE_NAME[s]} — Weekly Report — ${rangeLabel}`, html)) });
      }
    }

    await writeSnapshots(sb, d);
    return new Response(JSON.stringify({ ok: true, weekEnd: ymd(d.weekEnd), weekStart: ymd(d.weekStart), sent }, null, 2), { headers: cors });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 500) }), { status: 500, headers: cors });
  }
});
