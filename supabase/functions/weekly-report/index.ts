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
//   • kpi_entries             — weekly per-employee listings/conversion
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
//   &dryRun=1                            return HTML, don't send
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
const LEADERSHIP_TO: string[] = ['ethan.kushnir@speekstechnology.com', 'paul.kushnir@pikinvestments.com'];
// Per-store manager recipients. Falls back to DEFAULT_TO if a store is empty.
// (Multi-store managers are listed under each store they run.)
const STORE_TO: Record<string, string[]> = {
  OVL: ['nickhett707@gmail.com'],
  LEE: ['jurellguild@outlook.com'],
  WSP: ['eli.kushnir@speekstechnology.com'],
  MPL: ['josephorte191@hotmail.com'],
  BAL: ['josephorte191@hotmail.com'],
};

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const STORE_NAME: Record<string, string> = {
  OVL: 'Overland Park', LEE: "Lee's Summit", WSP: 'Westport', MPL: 'Maplewood', BAL: 'Ballwin',
};
const STORE_COLOR: Record<string, string> = {
  OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626',
};

// Brand palette (matches the site)
const C = {
  sage: '#5a8d3b', sageDeep: '#487130', charcoal: '#1a1c1e', app: '#f4f7f9',
  green: '#15803d', amber: '#d97706', red: '#dc2626', gold: '#f59e0b',
  line: '#e2e8f0', muted: '#64748b', faint: '#94a3b8', card: '#ffffff', soft: '#f8fafc',
};

// The SPEEKS Scorecard is now just the "Online & Marketing" four categories.
const SCORECARD_CATS: [string, string][] = [
  ['online_store_pictures', 'Online Store Pictures'],
  ['facebook_listings', 'Facebook Listings'],
  ['social_media_posts', 'Social Media Posts'],
  ['paymore_sync', 'PayMore Sync'],
];

// PayMore Audit Playbook v3 — section → item points (id:pts). Used to show
// per-section subtotals (where points were lost) in the manager email; the full
// item-level breakdown lives in the dashboard popout. (Totals = 165.)
const AUDIT_SECTIONS: { title: string; items: Record<string, number> }[] = [
  { title: 'Exterior', items: { ex1:1, ex2:1, ex3:1 } },
  { title: 'Entry & Sales Floor', items: { ef1:1, ef2:1, ef3:1, ef4:1, ef5:1, ef6:2, ef7:1, ef8:1, ef9:1, ef10:2, ef11:1, ef12:1, ef13:1, ef14:3 } },
  { title: 'Display Cases & Merchandising', items: { dc1:1, dc2:1, dc3:1, dc4:2, dc5:1, dc6:2, dc7:2, dc8:2, dc9:3, dc10:2, dc11:3, dc12:2 } },
  { title: 'Retail Counter', items: { rc1:1, rc2:1, rc3:1, rc4:1, rc5:1, rc6:1, rc7:2, rc8:1 } },
  { title: 'Buy Transaction Area', items: { bt1:3, bt2:1, bt3:2, bt4:2, bt5:1, bt6:1, bt7:2, bt8:3, bt9:7, bt10:3, bt11:3, bt12:4 } },
  { title: 'Back of House', items: { bh1:1, bh2:2, bh3:1, bh4:2, bh5:1, bh6:1, bh7:1, bh8:1, bh9:2, bh10:1, bh11:2, bh12:2, bh13:1, bh14:3, bh15:1, bh16:3, bh17:3, bh18:1, bh19:2, bh20:2, bh21:5, bh22:2, bh23:4, bh24:1, bh25:1, bh26:1 } },
  { title: 'Personnel & Appearance', items: { pa1:1, pa2:1, pa3:1, pa4:1, pa5:1, pa6:1 } },
  { title: 'Safety & Security', items: { ss1:3, ss2:2, ss3:2, ss4:4, ss5:5, ss6:2, ss7:1, ss8:1, ss9:1, ss10:4, ss11:1, ss12:1, ss13:1 } },
];

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

  // 2) weekly KPI rows for the week-ending Sunday
  const kpis = (await sb.from('kpi_entries').select('*')
    .eq('period_type', 'weekly').eq('period_end_date', weekEndStr)).data ?? [];

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
  const weekStartStr = ymd(weekStart);
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
    const soldRev = sumDays(sellA);
    const soldGp = sumDays(gpA);

    // listings (single week)
    const k = kpis.filter((r: any) => r.store === s);
    const processed = k.reduce((a: number, r: any) => a + n(r.listed_count), 0);
    const retail = k.reduce((a: number, r: any) => a + n(r.listed_retail_price), 0);
    const lcost = k.reduce((a: number, r: any) => a + n(r.listed_cost), 0);
    const lsold = k.reduce((a: number, r: any) => a + n(r.listed_sold_value), 0);
    const tgt = targetBy[s]?.current_target ?? 0;

    // MTD GP through endDay (cumulative array), with projection
    const gpCum = arr('leaderboard.gp', s).length ? arr('leaderboard.gp', s) : (hub?.leaderboard?.gp?.[s] ?? []);
    let gpMtd = 0;
    for (let d = endDay; d >= 1; d--) { const v = n(gpCum[d - 1]); if (v) { gpMtd = v; break; } }
    const gpGoal = n(hub?.[s.toLowerCase() + 'Goal']);
    const gpProj = endDay > 0 ? (gpMtd / endDay) * daysInMonth : 0;

    rows[s] = {
      store: s,
      boughtResale, boughtCash: cash, buyMargin: boughtResale ? ((boughtResale - cash) / boughtResale) * 100 : 0,
      soldRev, soldGp, gpMargin: soldRev ? (soldGp / soldRev) * 100 : 0,
      processed, retail, listedMargin: retail ? ((retail - lcost) / retail) * 100 : 0,
      pctSold: retail ? (lsold / retail) * 100 : 0,
      target: tgt, listingPct: tgt ? (processed / tgt) * 100 : 0, people: k.length,
      gpMtd, gpGoal, gpProj, goalPct: gpGoal ? (gpProj / gpGoal) * 100 : 0,
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
    const vals = STORES.map(s => rows[s].card?.[key]).filter(v => v != null).map(v => n(v) * 2);
    if (!vals.length) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg < lowestVal) { lowestVal = avg; lowestCat = label; }
  }

  return { weekStart, weekEnd, endDay, daysInMonth, sameMonth, rows, company, topPerformer, incomplete, lowestCat, lowestVal, kpis };
}

// ---------- shared HTML pieces (email-safe: tables + inline styles) ----------
const wrapEmail = (title: string, accent: string, range: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media only screen and (max-width:520px){.gtile{display:block!important;width:100%!important;padding:6px 0!important}.pace-l,.pace-r{display:block!important;width:100%!important;text-align:left!important}.pace-r{padding-top:6px!important;font-size:24px!important}.pace-cap{font-size:12.5px!important;line-height:1.5!important}}</style></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:16px;overflow:hidden;">
  <tr><td style="background:${C.charcoal};border-left:6px solid ${accent};padding:24px 26px;">
    <div style="color:#9fb89a;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;">Speeks Technology</div>
    <div style="color:#fff;font-size:22px;font-weight:900;margin-top:6px;">${title}</div>
    <div style="color:#c9d2cc;font-size:13px;font-weight:600;margin-top:3px;">${range}</div>
  </td></tr>
  <tr><td style="padding:22px;">${body}</td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:#fafbfc;">
    Generated automatically by Speeks · weekly figures are Mon–Sun. Goal pace is gross profit, month-to-date through the report week.
  </td></tr>
</table></td></tr></table></body></html>`;

const sectionLabel = (t: string, note = '') =>
  `<div style="margin:26px 2px 12px;border-left:3px solid ${C.sage};padding-left:10px;">
     <div style="font-size:16px;font-weight:900;color:${C.charcoal};letter-spacing:-.2px;">${t}</div>
     ${note ? `<div style="font-size:11px;font-weight:600;color:${C.faint};margin-top:1px;">${note}</div>` : ''}
   </div>`;

const tile = (label: string, value: string, sub: string) =>
  `<td class="gtile" width="33%" valign="top" style="padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:12px;"><tr><td style="padding:14px;">
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
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;"><tr><td style="padding:16px;">
    <table role="presentation" width="100%"><tr>
      <td class="pace-l" style="font-size:13px;font-weight:800;color:${C.muted};vertical-align:middle;">${label}</td>
      <td class="pace-r" align="right" style="font-size:20px;font-weight:900;color:${C.charcoal};white-space:nowrap;vertical-align:middle;">${moneyK(mtd)} <span style="font-size:12px;color:${C.muted};">MTD</span></td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 8px;background:#eef2f6;border-radius:99px;"><tr><td style="background:${C.sage};height:12px;width:${banked}%;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>
    <div class="pace-cap" style="font-size:11.5px;font-weight:600;color:${C.muted};line-height:1.4;">${money(goal)} goal · ${Math.round(banked)}% banked · <b style="color:${goalPct >= 100 ? C.green : C.amber}">on pace for ${moneyK(proj)} — ${Math.round(goalPct)}% of goal</b></div>
  </td></tr></table>`;
};

const th = (t: string, align = 'center') => `<th style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};background:${C.soft};padding:9px 7px;text-align:${align};border-bottom:1px solid ${C.line};">${t}</th>`;
const badge = (s: string) => `<span style="display:inline-block;background:${STORE_COLOR[s]};color:#fff;font-size:11px;font-weight:900;padding:2px 8px;border-radius:5px;letter-spacing:.5px;">${s}</span>`;
const procCell = (count: number, p: number) => `<div style="font-weight:900;font-size:13px;color:${C.charcoal};">${count}</div><div style="font-size:9.5px;font-weight:800;color:${tgtColor(p)};">${Math.round(p)}% of tgt</div>`;

// rank badge (1st green … 5th red) + a labeled stat cell for the cash-flow summary
const rankColor = (rk: number) => rk === 1 ? C.green : rk === 2 ? '#2563eb' : rk >= 5 ? C.red : rk === 4 ? C.amber : C.muted;
const rankBadge = (rk: number) => `<span style="display:inline-block;font-size:9px;font-weight:900;color:#fff;background:${rankColor(rk)};border-radius:99px;padding:1px 6px;margin-left:4px;vertical-align:middle;">#${rk}</span>`;
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
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;border-collapse:collapse;margin-bottom:10px;overflow:hidden;">
      <tr><td colspan="3" style="padding:11px 14px 0;"><span style="font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.6px;color:${C.charcoal};">${title}</span></td></tr>
      <tr>${cells}</tr>
      ${footer ? `<tr><td colspan="3" style="padding:0 14px 13px;">${footer}</td></tr>` : '<tr><td colspan="3" style="padding:0 0 6px;"></td></tr>'}
    </table>`;
  const bar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:9px 0 0;background:#eef2f6;border-radius:99px;"><tr><td style="background:${C.sage};height:10px;width:${banked}%;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const buying = channel('Buying',
    statCell('Buy Value', money(r.boughtResale), ranks?.buy ?? null) +
    statCell('Cash Cost', money(r.boughtCash)) +
    statCell('Buy Margin', pct(r.buyMargin), null, buyColor(r.buyMargin)),
    '');
  const selling = channel('Selling',
    statCell('Revenue', money(r.soldRev), ranks?.rev ?? null) +
    statCell('COGS', money(cogsSold)) +
    statCell('Sell Margin', pct(r.gpMargin), null, gpColor(r.gpMargin)),
    `<div style="font-size:12px;font-weight:700;color:${C.charcoal};">MTD Gross Profit ${money(r.gpMtd)} <span style="color:${C.muted};font-weight:600;">of ${money(r.gpGoal)} goal</span>${ranks?.gp != null ? rankBadge(ranks.gp) : ''}</div>${bar}<div style="font-size:11px;font-weight:600;color:${C.muted};margin-top:5px;">${Math.round(banked)}% banked · on pace for <b style="color:${goalPct >= 100 ? C.green : C.amber};">${moneyK(r.gpProj)} (${Math.round(goalPct)}% of goal)</b></div>`);
  return buying + selling;
}

function leaderboardTable(rows: Record<string, any>, company: any, youStore?: string) {
  const order = [...STORES].sort((a, b) => rows[b].soldGp - rows[a].soldGp);
  const goalC = (p: number) => (p >= 100 ? C.green : p >= 85 ? C.amber : C.red);
  const body = order.map((s, i) => {
    const r = rows[s]; const you = s === youStore;
    return `<tr${you ? ` style="background:#f0f7eb;"` : ''}>
      <td style="padding:9px 6px;text-align:center;font-weight:900;color:${i === 0 ? C.gold : C.faint};">${i + 1}</td>
      <td style="padding:9px 6px;">${badge(s)}${you ? ` <span style="font-size:10px;font-weight:900;color:#fff;background:${C.sage};padding:2px 6px;border-radius:5px;">YOU</span>` : ''}</td>
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
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;border-collapse:separate;">
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
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;border-collapse:separate;">
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
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;border-collapse:separate;">
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
  const m = { bad: ['#fef2f2', '#b91c1c', '#fecaca'], warn: ['#fffbeb', '#92400e', '#fde68a'], ok: ['#ecfdf5', '#065f46', '#a7f3d0'] }[kind];
  return `<span style="display:inline-block;font-size:11px;font-weight:800;padding:3px 9px;border-radius:99px;background:${m[0]};color:${m[1]};border:1px solid ${m[2]};margin:3px 4px 0 0;">${text}</span>`;
};

function flagsBlock(d: any) {
  const items: string[] = [];
  // any 0/10 scorecard categories across stores — immediate attention, listed first
  const zeros: string[] = [];
  for (const s of STORES) {
    if (!d.rows[s].card) continue;
    for (const [k, label] of SCORECARD_CATS) {
      const cv = d.rows[s].card[k];
      if (cv != null && n(cv) * 2 === 0) zeros.push(`${s} — ${label}`);
    }
  }
  if (zeros.length) items.push(`<div style="padding:11px 14px;border-bottom:1px solid #fde7b8;"><div style="font-size:13px;font-weight:900;color:${C.red};">${zeros.length} categor${zeros.length === 1 ? 'y' : 'ies'} scored 0/10 — immediate attention</div><div>${zeros.map(z => chip(z, 'bad')).join('')}</div></div>`);
  // listing target
  const under = STORES.filter(s => d.rows[s].listingPct < 100);
  if (under.length) {
    const chips = STORES.sort((a, b) => d.rows[a].listingPct - d.rows[b].listingPct)
      .map(s => chip(`${s} ${Math.round(d.rows[s].listingPct)}%`, d.rows[s].listingPct >= 100 ? 'ok' : d.rows[s].listingPct >= 80 ? 'warn' : 'bad')).join('');
    items.push(`<div style="padding:11px 14px;border-bottom:1px solid #fde7b8;"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">Listings — ${Math.round(d.company.listingPct)}% of target</div><div style="font-size:11.5px;color:${C.muted};font-weight:600;">${under.length} of 5 stores under goal</div><div>${chips}</div></div>`);
  }
  // buy margin
  const lowBuy = STORES.filter(s => d.rows[s].buyMargin < 51);
  if (lowBuy.length) {
    items.push(`<div style="padding:11px 14px;border-bottom:1px solid #fde7b8;"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">Buy margin under 51% floor</div><div>${lowBuy.map(s => chip(`${s} ${pct(d.rows[s].buyMargin)}`, 'bad')).join('')}</div></div>`);
  }
  // scorecard lowest
  if (d.lowestCat) items.push(`<div style="padding:11px 14px;border-bottom:1px solid #fde7b8;"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">${esc(d.lowestCat)} is the lowest scorecard category</div><div style="font-size:11.5px;color:${C.muted};font-weight:600;">Company average ${d.lowestVal.toFixed(1)}/10</div></div>`);
  // practice audit below the 80% pass line
  const failAudit = STORES.filter(s => d.rows[s].audit && d.rows[s].audit.pct < 80);
  if (failAudit.length) {
    items.push(`<div style="padding:11px 14px;border-bottom:1px solid #fde7b8;"><div style="font-size:13px;font-weight:900;color:${C.red};">${failAudit.length} store${failAudit.length === 1 ? '' : 's'} below the 80% audit pass line</div><div style="font-size:11.5px;color:${C.muted};font-weight:600;">target is 90%+</div><div>${failAudit.map(s => chip(`${s} ${d.rows[s].audit.pct}%`, 'bad')).join('')}</div></div>`);
  }
  // incomplete kpi
  if (d.incomplete.length) items.push(`<div style="padding:11px 14px;"><div style="font-size:13px;font-weight:900;color:${C.charcoal};">${d.incomplete.length} incomplete KPI ${d.incomplete.length === 1 ? 'entry' : 'entries'}</div><div>${d.incomplete.map((x: any) => chip(`${esc(x.name)} · ${x.store} — ${x.what}`, 'warn')).join('')}</div></div>`);
  if (!items.length) items.push(`<div style="padding:11px 14px;font-size:12.5px;color:${C.muted};">No flags this week.</div>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #fde68a;background:#fffbeb;border-radius:12px;overflow:hidden;"><tr><td style="background:#fef3c7;padding:9px 14px;font-size:12px;font-weight:900;color:#92400e;text-transform:uppercase;letter-spacing:.5px;">Live flags this week</td></tr><tr><td>${items.join('')}</td></tr></table>`;
}

function rowsBox(rowsHtml: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;">${rowsHtml}</table>`;
}

// ---------- leadership email ----------
function buildLeadership(d: any) {
  const range = `${fmtMD(d.weekStart)} – ${fmtMD(d.weekEnd)}, ${d.weekEnd.getFullYear()} · All Stores`;
  const tp = d.topPerformer;
  const tpConv = tp && n(tp.transaction_count) ? Math.round(100 * n(tp.transaction_converted) / n(tp.transaction_count)) : null;
  const cards = STORES.filter(s => d.rows[s].card).map(s => `${s} ${(n(d.rows[s].card.store_average) * 2).toFixed(1)}`).join(' · ');
  const audits = STORES.filter(s => d.rows[s].audit).map(s => {
    const a = d.rows[s].audit; const col = a.pct >= 90 ? C.green : (a.pct >= 80 ? '#d97706' : C.red);
    return `${s} <span style="color:${col};font-weight:900;">${a.pct}%</span>`;
  }).join(' · ');
  const kpiCount = STORES.filter(s => d.rows[s].kpiSubmitted).length;
  const peopleRows =
    (tp ? `<tr><td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;"><span style="font-size:9.5px;font-weight:900;color:#fff;background:${C.green};padding:3px 8px;border-radius:99px;">TOP PERFORMER</span> <b style="color:${C.charcoal};">${esc(tp.employee_name)} · ${tp.store}</b> <span style="color:${C.muted};font-size:11px;">${n(tp.listed_count)} processed${tpConv != null ? ` · ${tpConv}% conversion` : ''}</span></td></tr>` : '') +
    `<tr><td style="padding:11px 14px;font-size:12px;color:${C.charcoal};border-bottom:1px solid #f1f5f9;"><b>Scorecard averages</b> <span style="color:${C.muted};">${cards || '—'} /10</span></td></tr>` +
    `<tr><td style="padding:11px 14px;font-size:12px;color:${C.charcoal};"><b>PayMore Audit</b> <span style="color:${C.muted};">${audits || 'no practice audits yet'}</span> <span style="color:${C.muted};font-size:10.5px;">· pass 80% · target 90%+</span></td></tr>`;

  const body = `
  ${sectionLabel('Cash Flow Summary', 'all stores combined')}
  ${cashFlowSummary(d.company)}
  ${sectionLabel('Store Leaderboard', 'ranked by weekly gross profit')}
  ${leaderboardTable(d.rows, d.company)}
  ${sectionLabel('Buying Breakdown', 'ranked by volume bought · resale value vs cash paid')}
  ${buyingTable(d.rows, d.company)}
  ${sectionLabel('Listing Productivity by Store', 'ranked by % of target')}
  ${listingTable(d.rows, d.company)}
  ${sectionLabel('Needs Attention')}
  ${flagsBlock(d)}
  ${sectionLabel('People')}
  ${rowsBox(peopleRows)}
  ${sectionLabel('Ops Compliance')}
  ${rowsBox(`<tr><td style="padding:11px 14px;border-bottom:1px solid #f1f5f9;font-size:12.5px;"><b>Weekly KPIs submitted</b> <span style="float:right;font-weight:900;color:${kpiCount === 5 ? C.green : C.amber};">${kpiCount} / 5</span></td></tr><tr><td style="padding:11px 14px;font-size:12.5px;"><b>Audit Readiness</b> <span style="color:${C.faint};font-weight:600;">weekly % · daily avg % (Mon–Sun)</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${STORES.map(s => {
      const w = d.rows[s].auditWeeklyPct, da = d.rows[s].auditDailyPct;
      const ac = (p: number | null) => p == null ? C.faint : p >= 80 ? C.green : p >= 50 ? C.amber : C.red;
      const fmt = (p: number | null) => p == null ? '—' : Math.round(p) + '%';
      return `<tr><td style="padding:3px 0;">${badge(s)}</td><td align="right" style="font-weight:800;color:${ac(w)};">Weekly ${fmt(w)}</td><td align="right" style="font-weight:800;color:${ac(da)};padding-left:16px;">Daily ${fmt(da)}</td></tr>`;
    }).join('')}</table></td></tr>`)}
  `;
  return wrapEmail('Weekly Performance Report', C.sage, range, body);
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
  const gpRank = rankOf(x => x.soldGp);
  const revRank = rankOf(x => x.soldRev);
  const buyRank = rankOf(x => x.boughtResale);
  const listRank = rankOf(x => x.listingPct);
  const scoreRank = rankOf(x => x.card ? n(x.card.store_average) : -1);
  const auditRank = rankOf(x => x.audit ? x.audit.pct : -1);
  const auditPctStr = r.audit ? `${r.audit.pct}<span style="font-size:12px;">%</span>` : '—';

  // header card: store name + Scorecard / Listing / Audit (each ranked)
  const headTile = (label: string, rank: number, value: string) =>
    `<td width="50%" valign="top" style="padding:3px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,.16);border-radius:10px;"><tr><td style="padding:10px 13px;">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:rgba(255,255,255,.9);">${label}${rank > 0 ? rankBadge(rank) : ''}</div>
      <div style="font-size:21px;font-weight:900;color:#fff;margin-top:3px;">${value}</div>
    </td></tr></table></td>`;
  const headerCard = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${STORE_COLOR[store]};border-radius:14px;"><tr><td style="padding:18px 16px;">
    <div style="font-size:21px;font-weight:900;color:#fff;">${store} · ${STORE_NAME[store]}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
      <tr>
        ${headTile('Scorecard', r.card ? scoreRank : 0, r.card ? `${avg}<span style="font-size:12px;">/10</span>` : '—')}
        ${headTile('Listing Prod.', listRank, `${Math.round(r.listingPct)}<span style="font-size:12px;">% goal</span>`)}
      </tr>
      <tr>
        ${headTile('PayMore Audit', r.audit ? auditRank : 0, auditPctStr)}
        ${headTile('Audit Pass', 0, r.audit ? (r.audit.pct >= 80 ? `<span style="font-size:15px;">${r.audit.pct >= 90 ? 'On target ✓' : 'Passing'}</span>` : `<span style="font-size:15px;">Below 80%</span>`) : '—')}
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
    return `<tr${inc ? ' style="background:#fffbeb;"' : ''}>
      <td style="padding:9px 7px;font-weight:800;">${i === 0 ? '<span style="font-size:9px;font-weight:900;color:#fff;background:#15803d;padding:1px 6px;border-radius:99px;margin-right:5px;">TOP</span>' : ''}${esc(k.employee_name)}${inc ? ` <span style="font-size:9px;font-weight:800;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:99px;padding:1px 7px;">incomplete KPI</span>` : ''}</td>
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
    ? SCORECARD_CATS.map(([k, label]) => ({ label, v: r.card[k] == null ? null : n(r.card[k]) * 2 })).filter(x => x.v != null).sort((a, b) => (a.v as number) - (b.v as number))
    : [];
  let scoreHtml = `<tr><td colspan="2" style="padding:11px 14px;color:${C.muted};font-size:12px;">No scorecard on file for this period.</td></tr>`;
  if (r.card) {
    scoreHtml = scoredCats.map(x => {
      const v = x.v as number;
      return `<tr><td style="padding:8px 14px;font-weight:700;color:${C.charcoal};font-size:12px;border-bottom:1px solid #f1f5f9;width:70%;">${x.label}</td>
        <td style="padding:8px 14px;text-align:right;font-weight:900;color:${scoreColor(v)};border-bottom:1px solid #f1f5f9;">${v}</td></tr>`;
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
      return `<tr><td style="padding:8px 14px;font-weight:700;color:${C.charcoal};font-size:12px;border-bottom:1px solid #f1f5f9;width:70%;">${sec.title}</td>
        <td style="padding:8px 14px;text-align:right;font-weight:900;color:${col};border-bottom:1px solid #f1f5f9;">${sec.earned}/${sec.total}</td></tr>`;
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
  if (r.buyMargin >= 51) focus.push(`<span style="color:${C.green};">●</span> <b>Buy margin ${pct(r.buyMargin)}</b> — keep the buying discipline up.`);

  const body = `
  ${headerCard}
  ${sectionLabel('Cash Flow Summary')}
  ${cashFlowSummary(r, { buy: buyRank, rev: revRank, gp: gpRank })}
  ${sectionLabel('Where You Stand', 'all stores this week · ranked by gross profit')}
  ${leaderboardTable(d.rows, d.company, store)}
  ${sectionLabel('Listing Productivity', `${r.processed} of ${r.target} target · ${Math.round(r.listingPct)}%`)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;border-collapse:separate;">
    <tr>${th('Lister', 'left')}${th('Listed')}${th('Retail $')}${th('Margin')}${th('% Sold')}</tr>${teamRows}${teamTotal}
  </table>
  ${sectionLabel('Scorecard', r.card ? `Online & Marketing · ${avg}/10` : '')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;">${scoreHtml}</table>
  ${sectionLabel('PayMore Audit', r.audit ? `${r.audit.earned}/${r.audit.possible} · ${r.audit.pct}% · pass 80% · target 90%+` : '')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:12px;overflow:hidden;">${auditHtml}</table>
  ${focus.length ? sectionLabel('Focus This Week') + rowsBox(focus.map(f => `<tr><td style="padding:10px 14px;font-size:12.5px;border-bottom:1px solid #f1f5f9;">${f}</td></tr>`).join('')) : ''}
  `;
  return wrapEmail('Your Weekly Report', STORE_COLOR[store], range, body);
}

// ---------- send (Gmail relay preferred, Resend fallback) ----------
async function sendEmail(to: string[], subject: string, html: string) {
  // Gmail relay: a tiny Apps Script web app that sends via GmailApp. No DNS.
  const relay = GMAIL_RELAY;
  if (relay) {
    const res = await fetch(relay, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
async function writeSnapshots(sb: any, d: any) {
  const weekEnd = ymd(d.weekEnd);
  const recs = STORES.map(s => {
    const r = d.rows[s];
    return {
      week_end: weekEnd, store: s, bought_resale: r.boughtResale, bought_cash: r.boughtCash, buy_margin_pct: r.buyMargin,
      sold_revenue: r.soldRev, sold_gp: r.soldGp, gp_margin_pct: r.gpMargin, processed: r.processed, listing_target: r.target,
      listing_pct: r.listingPct, retail_value: r.retail, listed_margin_pct: r.listedMargin, pct_sold: r.pctSold,
      gp_mtd: r.gpMtd, gp_goal: r.gpGoal, gp_proj: r.gpProj, goal_pct: r.goalPct,
      scorecard_avg: r.card ? n(r.card.store_average) * 2 : null,
      audit_pct: r.audit ? r.audit.pct : null,
      audit_earned: r.audit ? r.audit.earned : null,
    };
  });
  recs.push({
    week_end: weekEnd, store: 'ALL', bought_resale: d.company.boughtResale, bought_cash: d.company.boughtCash, buy_margin_pct: d.company.buyMargin,
    sold_revenue: d.company.soldRev, sold_gp: d.company.soldGp, gp_margin_pct: d.company.gpMargin, processed: d.company.processed,
    listing_target: d.company.target, listing_pct: d.company.listingPct, retail_value: d.company.retail, listed_margin_pct: d.company.listedMargin,
    pct_sold: d.company.pctSold, gp_mtd: d.company.gpMtd, gp_goal: d.company.gpGoal, gp_proj: d.company.gpProj, goal_pct: d.company.goalPct, scorecard_avg: null,
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
