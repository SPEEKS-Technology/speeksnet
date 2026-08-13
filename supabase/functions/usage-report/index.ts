import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// SITE USAGE REPORT — daily, weekly and monthly, all 8:00pm Central.
// ----------------------------------------------------------------------------
// Answers one question the site could not answer before: of the people who were
// supposed to be on the floor, how many actually used any of this, and which
// tools did they touch. Everything the site recorded until now was a side
// effect of someone WRITING something — a checklist tick, a read receipt — so
// read-only tools like the Margin Guide were completely invisible. The `usage`
// edge function now logs opens; this reads them.
//
// THREE MODES, ONE FUNCTION (`?mode=day|week|month`).
//   day   — that day, midnight to 8pm Central. Fires every night.
//   week  — Monday through Saturday. Fires Saturday night.
//   month — the 1st through the last open day. Fires on the month's last day,
//           or the Saturday before if that last day is a Sunday.
// Sunday is excluded from every range: the stores are shut, so a person owed no
// role can't be counted absent.
//
// Week and month are the same numbers aggregated, not different numbers. The
// coverage denominator becomes PERSON-DAYS — six open days times the people
// staffed on each — which is the only honest way to add up a ratio whose
// denominator moves daily.
//
// A SHORT, DELIBERATE TOOL LIST (Ethan 2026-08-08). Only the surfaces in
// SURFACES are tracked, and the beacon's own allow-list in speeks.js matches it
// key for key. Tools with a due date attached get opened because the deadline
// forces it; tools that write to the database are already countable without a
// beacon. What is measured here is the reading and reference material, which was
// invisible before and is the only place a real choice is being made.
//
// The denominator comes from Listing Goals: managers give every person a role or
// an Off each open day, so "expected on the floor" is derivable. Where a store
// hasn't set roles we fall back to its full roster and say so.
// ============================================================================

const SECRET = 'sp33ks-sync-k3y-2026-x9mq';
const GMAIL_RELAY = Deno.env.get('GMAIL_RELAY_URL') ||
  'https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec';
const RESEND_URL = 'https://api.resend.com/emails';
const FROM = Deno.env.get('RESEND_FROM') || 'onboarding@resend.dev';
const LIST_KEY = 'usage_report';
const FALLBACK_TO = ['ethan.kushnir@speekstechnology.com'];

const STORES = ['OVL', 'LEE', 'WSP', 'MPL', 'BAL'];
const STORE_NAME: Record<string, string> = {
  OVL: 'Overland Park', LEE: "Lee's Summit", WSP: 'Westport', MPL: 'Maplewood', BAL: 'Ballwin',
};
const STORE_COLOR: Record<string, string> = {
  OVL: '#7c3aed', LEE: '#2563eb', WSP: '#16a34a', MPL: '#ea580c', BAL: '#dc2626',
};
const STORE_TINT: Record<string, string> = {
  OVL: '#f1ebfd', LEE: '#e8f0fb', WSP: '#e8f7ee', MPL: '#fdf0e7', BAL: '#fcecec',
};
const STORE_RING: Record<string, string> = {
  OVL: '#ddd0fb', LEE: '#cfe0f7', WSP: '#c6ecd6', MPL: '#f8dcc7', BAL: '#f6d5d5',
};

type Mode = 'day' | 'week' | 'month';

// Airy V4 palette — same object the weekly report uses, so the two emails read
// as one family. See the "V4 airy" block in styles.css.
const C = {
  sage: '#1f9d57', sageDeep: '#178048', tint: '#e8f7ee',
  charcoal: '#1a1c1e', app: '#f1f5f2', card: '#ffffff', soft: '#f7faf8',
  green: '#1f9d57', amber: '#c07f0c', red: '#d64545', gold: '#e8a020',
  line: '#eaefeb', line2: '#f4f8f5', track: '#eaefeb',
  muted: '#64707c', faint: '#9aa6ad',
  flagBg: '#fefaf3', flagRule: '#f4e3c4', flagBorder: '#f0dcb6', flagHead: '#fdf3e1', flagInk: '#8a5a06',
  footBg: '#f7faf8',
  rCard: 18, rBox: 14,
};

// Who counts as a person owed a role today. MOCD is corp-wide, and `store` is the
// shop-floor TV board — counted, a TV would read as the most diligent employee
// in the company. Mirrors the roster rule in kpi-manage, NOT store-targets'
// (which drops the MSM on purpose for target sizing; here Joseph should count).
const ROSTER_EXCLUDE = new Set(['ceo', 'district manager', 'mocd', 'tom', 'store']);
const MULTISTORE_MANAGER_STORES = ['BAL', 'MPL'];
const GOALS_OFF = 'OFF';

// The tracked surfaces, in the order they appear in the email: key, label, group.
// This MUST stay in step with USAGE_TRACK in speeks.js — that list decides what
// is recorded, this one decides what is reported, and a key in one but not the
// other either goes uncounted or shows as permanently untouched.
const GROUPS = ['Announcements & Updates', 'Operational Tools', 'Tools & Resources', 'Pages & Charts'];
const SURFACES: [string, string, string][] = [
  ['patchNotesModal', 'Patch Notes', GROUPS[0]],
  ['annDocsModal', 'Documents', GROUPS[0]],
  // One row each, and it counts USE rather than arrival (Ethan 2026-08-08).
  // Margin Guide = a category and an item picked; Processes & Policies = a
  // document actually opened. Opening the tab or landing on the library page is
  // not tracked at all — visiting a page says nothing about using it.
  ['mg:lookup', 'Margin Guide', GROUPS[1]],
  ['ops:callbacks', 'Customer Call Backs', GROUPS[1]],
  ['hotkeysDropdown', 'Hotkeys & Commands', GROUPS[2]],
  ['quickMsgDropdown', 'Quick Messages', GROUPS[2]],
  ['calendarDropdown', 'Strategic Calendar', GROUPS[2]],
  ['doc:open', 'Processes & Policies', GROUPS[3]],
  ['page:stats', 'Stats & Awards page', GROUPS[3]],
  ['chart:home', 'KPI Charts', GROUPS[3]],
];
const SURFACE_LABEL: Record<string, string> = {};
SURFACES.forEach(([k, l]) => { SURFACE_LABEL[k] = l; });

// ---------- small helpers ----------
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Announcement bodies are stored as HTML. Strip the tags AND decode the entities
// before the text is re-escaped for the email — otherwise esc() turns a stored
// `&nbsp;` into `&amp;nbsp;` and the reader sees "&nbsp;" in the sentence.
function plainText(s: unknown, max: number): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')   // last, so &amp;lt; doesn't double-decode
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const firstName = (s: unknown) => String(s ?? '').trim().split(' ')[0];

// Same loose match the Listing Goals widgets use: exact, or a first-name prefix
// (min 3 chars). The goals sheet is typed by hand and "Zach" vs "Zach Marbs" is
// routine.
function sameName(a: unknown, b: unknown): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xf = x.split(' ')[0], yf = y.split(' ')[0];
  return xf.length > 2 && yf.length > 2 && (xf.startsWith(yf) || yf.startsWith(xf));
}

function centralToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// The UTC instant at which the Central wall clock reads `hour`:00 on `day`.
// The cron fires at 01:00/02:00 UTC — the NEXT UTC calendar day — so every date
// boundary in this function has to be computed in Central or the whole report
// silently covers the wrong day. Offsets are tried rather than hardcoded so DST
// needs no maintenance.
function centralInstant(day: string, hour: number): Date {
  for (const off of [5, 6]) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCHours(hour + off);
    const gotDay = d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const gotHour = Number(d.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }));
    if (gotDay === day && gotHour === hour) return d;
  }
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCHours(hour + 5);
  return d;
}

// Plain calendar arithmetic on YYYY-MM-DD. Noon UTC keeps every date safely
// inside its own day whichever way the offset falls.
const addDays = (day: string, n: number) => {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dowOf = (day: string) => new Date(day + 'T12:00:00Z').getUTCDay();   // 0 = Sunday
// Monday-start weeks, matching getPeriodStart() in the checklist function and
// periodStartFor() in store-audit. Both stamp weekly work with the Monday, so a
// different week boundary here would compare against the wrong period row.
const mondayOf = (day: string) => addDays(day, dowOf(day) === 0 ? -6 : -(dowOf(day) - 1));
const monthStartOf = (day: string) => day.slice(0, 8) + '01';

// The open days a report covers. Sundays are dropped: the stores are shut, so
// nobody is owed a role and counting the day would dilute every ratio.
function daysCovered(endDay: string, mode: Mode): string[] {
  if (mode === 'day') return [endDay];
  const start = mode === 'week' ? mondayOf(endDay) : monthStartOf(endDay);
  const out: string[] = [];
  for (let d = start; d <= endDay; d = addDays(d, 1)) if (dowOf(d) !== 0) out.push(d);
  return out.length ? out : [endDay];
}

function prettyDay(day: string): string {
  const d = new Date(day + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}
function shortDay(day: string): string {
  const d = new Date(day + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
function monthLabel(day: string): string {
  const d = new Date(day + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

function isSunday(day: string): boolean { return dowOf(day) === 0; }

function pctColor(p: number): string {
  return p >= 90 ? C.green : p >= 70 ? C.amber : C.red;
}
const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);
// Every day-count in this email is a real number a person reads, and a week that
// runs Monday–Saturday hits 1 often enough that "1 Days No Roles" was showing up
// in the live rendering. Title Case because every other noun in the email is.
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---------- gather ----------
async function gather(sb: any, endDay: string, mode: Mode) {
  const days = daysCovered(endDay, mode);
  const daySet = new Set(days);
  const rangeStart = centralInstant(days[0], 0).toISOString();
  const rangeEnd = centralInstant(endDay, 20).toISOString();
  const weekBefore = centralInstant(days[0], 0);
  weekBefore.setUTCDate(weekBefore.getUTCDate() - 7);

  // A week can straddle a month boundary, so monthly goals are fetched for
  // every month the range touches.
  const months = [...new Set(days.map(d => d.slice(0, 7)))];
  // Weekly work is stamped with its Monday; a month covers several.
  const mondays = [...new Set(days.map(mondayOf))];

  const [
    usersQ, goalsQ, monthGoalsQ, tasksQ, auditItemsQ, eventsQ, priorEventsQ,
    annQ, annReadsQ, commentsQ, commentReadsQ, checklistQ, auditQ, snapsQ,
  ] = await Promise.all([
    sb.from('users').select('name, role, store, pin'),
    sb.from('listing_goals').select('store, employee, role, date').in('date', days),
    // Monthly team goals. `year_month` also carries a literal 'initiatives' row
    // (Company Projects), which the .in excludes for free.
    sb.from('goals').select('store, title, year_month').in('year_month', months),
    // The checklist's denominators. Mirrors the `or()` the checklist fn builds
    // for a retail store: a legacy RETAIL broadcast, or a task flagged for this
    // store. Personal tasks (assigned_user set, is_global false) are excluded —
    // they belong to one person, not to the store's list.
    sb.from('checklist_tasks').select('id, tab, store, is_global, assigned_user, applies_ovl, applies_lee, applies_wsp, applies_mpl, applies_bal'),
    sb.from('audit_items').select('id, period, active'),
    sb.from('usage_events').select('user_name, store, event, feature, opens, occurred_at, day')
      .in('day', days).lt('occurred_at', rangeEnd),
    // The seven days before the range, used only to tell "untouched" from "cold".
    sb.from('usage_events').select('feature').gte('occurred_at', weekBefore.toISOString()).lt('occurred_at', rangeStart),
    sb.from('announcements').select('id, message, author, date, high_priority, doc_only').in('date', days),
    sb.from('announcement_reads').select('announcement_id, user_pin, read_at'),
    sb.from('store_comments').select('id, store, author, message, date').in('date', days),
    sb.from('store_comment_reads').select('comment_id, user_name, read_at'),
    sb.from('checklist_completions').select('task_id, user_name, store, completed_at').gte('completed_at', rangeStart).lt('completed_at', rangeEnd),
    // Audit ticks carry their own period stamp, so they are read by period_start
    // rather than by clock time — that is the field the store's board checks.
    sb.from('audit_completions').select('item_id, store, period_start, user_name').in('period_start', [...days, ...mondays]),
    sb.from('usage_daily_snapshots').select('day, store, payload').eq('store', 'ALL').lt('day', days[0]).order('day', { ascending: false }).limit(7),
  ]);

  const allUsers = usersQ.data || [];
  const pinToUser = new Map<string, any>();
  allUsers.forEach((u: any) => { if (u.pin) pinToUser.set(String(u.pin), u); });
  const nameOf = new Map<string, string>();
  allUsers.forEach((u: any) => nameOf.set(norm(u.name), u.name));

  // Roster per store. The MSM's DB store is their home store only, so they are
  // folded into both stores they actually cover.
  const rosterFor = (store: string) => {
    const base = allUsers.filter((u: any) =>
      String(u.store || '').toUpperCase() === store &&
      !ROSTER_EXCLUDE.has(norm(u.role)));
    const msm = allUsers.filter((u: any) =>
      norm(u.role) === 'multi-store manager' &&
      MULTISTORE_MANAGER_STORES.includes(store) &&
      String(u.store || '').toUpperCase() !== store);
    return [...base, ...msm];
  };

  // ---- usage events ----
  // Two per-day sets (was anyone here / did they open a tracked tool) plus one
  // period-wide roll-up per tool. Coverage has to be answered a day at a time
  // even in week and month mode, because the staffing it is measured against
  // changes every day.
  const signedInOn = new Map<string, Set<string>>();
  const usedToolOn = new Map<string, Set<string>>();
  days.forEach(d => { signedInOn.set(d, new Set()); usedToolOn.set(d, new Set()); });
  const featuresByUser = new Map<string, Set<string>>();
  // Tool → the "day|person" PAIRS that used it, so a week can be measured in
  // person-days like its coverage is. Distinct people alone stopped saying
  // anything over a long period: on a month almost every live tool reads 4/4
  // (Ethan 2026-08-09), because touching it once in twenty-six days is enough.
  const usedPairs = new Map<string, Set<string>>();

  for (const e of (eventsQ.data || [])) {
    const k = norm(e.user_name);
    if (!k || !daySet.has(e.day)) continue;
    signedInOn.get(e.day)!.add(k);
    if (e.event === 'signin') continue;
    // Only the tracked list. Anything else is a stale client and is dropped here
    // once, so every count downstream agrees with the tool table.
    if (!SURFACE_LABEL[e.feature]) continue;
    usedToolOn.get(e.day)!.add(k);
    if (!featuresByUser.has(k)) featuresByUser.set(k, new Set());
    featuresByUser.get(k)!.add(e.feature);
    if (!usedPairs.has(e.feature)) usedPairs.set(e.feature, new Set());
    usedPairs.get(e.feature)!.add(e.day + '|' + k);
  }

  // ---- checklist + cleaning-checklist denominators ----
  const STORE_COL: Record<string, string> = {
    OVL: 'applies_ovl', LEE: 'applies_lee', WSP: 'applies_wsp', MPL: 'applies_mpl', BAL: 'applies_bal',
  };
  // A store's shared list for one tab. Completions are recorded per PERSON, so a
  // store-level number only means "of the required tasks, how many got ticked by
  // anyone" — always counted on DISTINCT task. Counting raw rows also sweeps in
  // other tabs and personal tasks, which is how LEE once showed 14 completions
  // against a 13-item daily list.
  const taskIds = (store: string, tab: string) => new Set((tasksQ.data || []).filter((t: any) =>
    String(t.tab || 'daily').toLowerCase() === tab &&
    (t.is_global === true || ((t.store === 'RETAIL' || t.store === 'CORP') && !t.assigned_user)) &&
    (t.store === 'RETAIL' || t[STORE_COL[store]] === true)).map((t: any) => t.id));

  const auditIds = (period: string) => new Set((auditItemsQ.data || [])
    .filter((i: any) => String(i.period || 'weekly') === period && i.active !== false)
    .map((i: any) => i.id));
  const auditDaily = auditIds('daily');
  const auditWeekly = auditIds('weekly');

  const checklistRows = checklistQ.data || [];
  const auditRows = auditQ.data || [];

  // Daily checklist ticks for one store on one day, distinct task.
  const clDoneOn = (store: string, day: string, ids: Set<string>) => {
    const lo = centralInstant(day, 0).toISOString();
    const hi = centralInstant(day, 20).toISOString();
    return new Set(checklistRows.filter((r: any) =>
      String(r.store || '').toUpperCase() === store && ids.has(r.task_id) &&
      r.completed_at >= lo && r.completed_at < hi).map((r: any) => r.task_id)).size;
  };
  // Ticks anywhere in the range — the right shape for weekly/monthly tabs,
  // which reset once per period rather than once per day.
  const clDoneInRange = (store: string, ids: Set<string>, from: string, to?: string) => new Set(
    checklistRows.filter((r: any) =>
      String(r.store || '').toUpperCase() === store && ids.has(r.task_id) &&
      r.completed_at >= from && (!to || r.completed_at < to)).map((r: any) => r.task_id)).size;

  // Weekly tasks across a MONTH: the weekly list resets every Monday, so the
  // month's numerator is a sum of per-week counts, not one distinct count over
  // the whole range — otherwise a task ticked in all four weeks reads as one.
  // Unlike the audit, checklist completions carry no period stamp, so the weeks
  // are cut by clock time.
  const clDoneByWeek = (store: string, ids: Set<string>, weekStarts: string[]) =>
    weekStarts.reduce((a, m) => a + clDoneInRange(
      store, ids, centralInstant(m, 0).toISOString(), centralInstant(addDays(m, 7), 0).toISOString()), 0);

  const auDoneOn = (store: string, periodStart: string, ids: Set<string>) => new Set(
    auditRows.filter((r: any) =>
      String(r.store || '').toUpperCase() === store && r.period_start === periodStart &&
      ids.has(r.item_id)).map((r: any) => r.item_id)).size;

  const goals = goalsQ.data || [];
  const realRole = (r: unknown) => { const v = String(r ?? '').trim(); return v !== '' && v !== '-'; };
  const workingRole = (r: unknown) => realRole(r) && String(r).trim().toUpperCase() !== GOALS_OFF;

  const rows: Record<string, any> = {};
  const perDay: { day: string; expected: number; active: number }[] =
    days.map(d => ({ day: d, expected: 0, active: 0 }));

  for (const s of STORES) {
    const roster = rosterFor(s);
    let expected = 0, active = 0, engaged = 0, daysRolesSet = 0;
    // Person → how many days they were in each state. One row per person in the
    // overview no matter how long the period is; the count carries the weight.
    const missed = new Map<string, number>();
    const idle = new Map<string, number>();
    const unaccounted = new Map<string, number>();
    // How many of the period's days each person was actually staffed on. The
    // denominator for the two counts above: "missed 3" means nothing without it,
    // since a part-timer on three shifts and a full-timer on six are the same 3.
    const dueDays = new Map<string, number>();
    // Every "day|person" this store had on the floor — the SAME pairs `expected`
    // counts, kept so the tool table can intersect against them. Without it a
    // tool could out-score the coverage it is measured against, by counting a
    // lookup made on a day that person was not scheduled.
    const staffedPairs = new Set<string>();

    days.forEach((day, di) => {
      const dGoals = goals.filter((g: any) => String(g.store || '').toUpperCase() === s && g.date === day);
      const rolesSet = dGoals.some((g: any) => realRole(g.role));
      if (rolesSet) daysRolesSet++;

      const assigned = dGoals.filter((g: any) => workingRole(g.role)).map((g: any) => g.employee);
      const off = dGoals.filter((g: any) => realRole(g.role) && !workingRole(g.role)).map((g: any) => g.employee);

      // Expected = who the manager staffed. With no roles set at all we can't
      // know, so we fall back to the whole roster and flag it rather than
      // reporting a store as having nobody expected (which reads as 100%).
      //
      // A goals-sheet name matching nobody on the roster — almost always someone
      // who has left — is IGNORED outright (Ethan 2026-08-09): filtering the
      // roster means it never reaches the denominator, and there is deliberately
      // no section pointing it out either.
      const due = rolesSet
        ? roster.filter((u: any) => assigned.some((a: string) => sameName(a, u.name)))
        : roster.slice();

      const inToday = signedInOn.get(day)!;
      const toolToday = usedToolOn.get(day)!;
      due.forEach((u: any) => {
        const k = norm(u.name);
        expected++; perDay[di].expected++;
        dueDays.set(u.name, (dueDays.get(u.name) || 0) + 1);
        staffedPairs.add(day + '|' + k);
        if (inToday.has(k)) {
          active++; perDay[di].active++;
          if (toolToday.has(k)) engaged++;
          else idle.set(u.name, (idle.get(u.name) || 0) + 1);
        } else {
          missed.set(u.name, (missed.get(u.name) || 0) + 1);
        }
      });

      // On the roster, given neither a role nor an off day. The exact gap the
      // Off chip was added to close. Anyone who signed in is dropped — the sheet
      // not being filled in matters far less once we can see they worked.
      if (rolesSet) {
        roster.forEach((u: any) => {
          if (assigned.some((a: string) => sameName(a, u.name))) return;
          if (off.some((o: string) => sameName(o, u.name))) return;
          if (inToday.has(norm(u.name))) return;
          unaccounted.set(u.name, (unaccounted.get(u.name) || 0) + 1);
        });
      }
    });

    // ---- the store's checklists over the period ----
    const dailyTasks = taskIds(s, 'daily');
    const dailyDone = days.reduce((a, d) => a + clDoneOn(s, d, dailyTasks), 0);
    const auDailyDone = days.reduce((a, d) => a + auDoneOn(s, d, auditDaily), 0);

    const periodTab = mode === 'month' ? 'monthly' : 'weekly';
    const periodTasks = taskIds(s, periodTab);
    const weeklyTasks = mode === 'month' ? taskIds(s, 'weekly') : periodTasks;
    const periodFrom = centralInstant(mode === 'month' ? monthStartOf(endDay) : mondayOf(endDay), 0).toISOString();
    const auWeeklyDone = mondays.reduce((a, m) => a + auDoneOn(s, m, auditWeekly), 0);

    rows[s] = {
      store: s, roster,
      expected, active, engaged,
      daysRolesSet, daysTotal: days.length,
      missed, idle, unaccounted, dueDays, staffedPairs,
      checklist: { done: dailyDone, total: dailyTasks.size * days.length },
      cleaning: { done: auDailyDone, total: auditDaily.size * days.length },
      // The period's own list — weekly tasks on a weekly report, monthly on a
      // monthly one. Empty when a period has no items at that cadence.
      checklistPeriod: { done: clDoneInRange(s, periodTasks, periodFrom), total: periodTasks.size, tab: periodTab },
      // The weekly checklist across the whole period — only the monthly report
      // shows it (a weekly report's own `checklistPeriod` IS this).
      checklistWeekly: {
        done: clDoneByWeek(s, weeklyTasks, mondays),
        total: weeklyTasks.size * mondays.length,
      },
      cleaningPeriod: { done: auWeeklyDone, total: auditWeekly.size * mondays.length, tab: 'weekly' },
      monthlyGoals: (monthGoalsQ.data || []).filter((g: any) =>
        String(g.store || '').toUpperCase() === s && String(g.title || '').trim() &&
        g.year_month === endDay.slice(0, 7)).length,
    };
  }

  // ---- tool adoption across the district ----
  // Which stores a person answers to, from the rosters rather than the store
  // stamped on the event. Two things fall out for free: CORP and the TV boards
  // are on no roster and so are silently excluded, and the Multi-Store Manager
  // is on two, so one Margin Guide lookup shows under both his stores.
  const storesForPerson = new Map<string, string[]>();
  STORES.forEach(s => rows[s].roster.forEach((u: any) => {
    const k = norm(u.name);
    storesForPerson.set(k, [...(storesForPerson.get(k) || []), s]);
  }));

  // Each store's cell in the tool table is measured in the SAME unit as its
  // coverage: person-days. "4/4 people touched the Margin Guide this month"
  // is true of anything anybody uses at all and discriminates nothing; "112 of
  // 156 person-days had a lookup on them" is a habit (Ethan 2026-08-09).
  //
  // On a daily report a person-day IS a person, so the number reads the same as
  // before — except the denominator is now who was STAFFED rather than the whole
  // roster, which is what the coverage table above has always used.
  const rosterSize: Record<string, number> = {};
  const personDays: Record<string, number> = {};
  STORES.forEach(s => {
    rosterSize[s] = rows[s].roster.length;
    personDays[s] = rows[s].expected;
  });
  const tally = (perStore: Map<string, Set<string>> | null) => {
    const out: Record<string, number> = {};
    STORES.forEach(s => { out[s] = perStore ? (perStore.get(s)?.size || 0) : 0; });
    return out;
  };
  // Staffed person-days at this store that also used the tool. Intersecting
  // rather than counting the tool's own pairs is what keeps a cell from ever
  // exceeding its denominator: a lookup on an unscheduled day is not in either.
  const pairsAtStore = (key: string) => {
    const used = usedPairs.get(key);
    const out: Record<string, number> = {};
    STORES.forEach(s => {
      if (!used) { out[s] = 0; return; }
      let n = 0;
      rows[s].staffedPairs.forEach((p: string) => { if (used.has(p)) n++; });
      out[s] = n;
    });
    return out;
  };

  const toolUse = new Map<string, { users: Set<string>; perStore: Map<string, Set<string>> }>();
  featuresByUser.forEach((feats, k) => {
    const mine = storesForPerson.get(k);
    if (!mine) return;
    feats.forEach(key => {
      let t = toolUse.get(key);
      if (!t) { t = { users: new Set(), perStore: new Map() }; toolUse.set(key, t); }
      const nm = nameOf.get(k) || k;
      t.users.add(nm);
      // The Multi-Store Manager is on two rosters, so his one lookup counts at
      // both — the same rule the coverage table runs on.
      mine.forEach(s => {
        if (!t!.perStore.has(s)) t!.perStore.set(s, new Set());
        t!.perStore.get(s)!.add(nm);
      });
    });
  });
  const warmBefore = new Set((priorEventsQ.data || []).map((r: any) => r.feature));
  // "Cold" is a claim about the days before this range, and it is only sayable
  // if the beacon was running then. With an empty run-up — the launch week, or
  // after an outage — every tool would be branded cold in red on the strength of
  // no evidence at all. Silence is not a finding.
  const haveHistory = warmBefore.size > 0;

  // ---- announcements ----
  // They used to have a section of their own, quoting each post and naming every
  // person who hadn't read it. Here the only thing asked of the tool table is
  // how many people marked the period's posts read; week and month reports get a
  // separate "least read" list, which is the actionable half.
  //
  // Note these are READ RECEIPTS, not beacon events — `announcement_reads` has
  // recorded them all along, so no client change was ever needed.
  const readsByAnn = new Map<string, Set<string>>();
  (annReadsQ.data || []).forEach((r: any) => {
    const u = pinToUser.get(String(r.user_pin));
    if (!u) return;
    if (!readsByAnn.has(r.announcement_id)) readsByAnn.set(r.announcement_id, new Set());
    readsByAnn.get(r.announcement_id)!.add(norm(u.name));
  });
  const posted = annQ.data || [];
  const audienceSize = storesForPerson.size;
  // An announcement has no per-day rhythm, so its pairs are POST × person rather
  // than day × person: of every chance this store's people had to read the
  // period's posts, how many were taken. Same shape as the tool cells, and it
  // stops a month of twenty posts reading 4/4 off one person opening one of them.
  const readersOf = (list: any[]) => {
    const names = new Set<string>(), perStore: Record<string, number> = {};
    STORES.forEach(s => { perStore[s] = 0; });
    list.forEach((a: any) => (readsByAnn.get(a.id) || new Set<string>()).forEach((n: string) => {
      const ss = storesForPerson.get(n);
      if (!ss) return;   // CORP and the boards read plenty; they aren't the audience
      names.add(n);
      ss.forEach(s => { perStore[s]++; });
    }));
    const denom: Record<string, number> = {};
    STORES.forEach(s => { denom[s] = list.length * rosterSize[s]; });
    return { users: names.size, counts: perStore, denom };
  };
  const annRow = (label: string, list: any[]) => {
    const { users, counts, denom } = readersOf(list);
    return {
      key: 'ann:' + label, label, group: GROUPS[0], users, counts, denom,
      // Three distinct states, and they must not be confused: nothing was posted
      // (nobody could have read it), something was posted and nobody read it, or
      // n people read it.
      empty: list.length ? 'Nobody Read It' : 'None Posted',
      emptyKind: (list.length ? 'bad' : 'plain') as 'bad' | 'plain',
    };
  };
  const annTools = [
    annRow('Announcements', posted.filter((a: any) => !a.doc_only && !a.high_priority)),
    annRow('High Priority Announcements', posted.filter((a: any) => !a.doc_only && a.high_priority)),
  ];

  // The worst-read posts of the period, for the week and month reports.
  const worstAnn = posted.map((a: any) => {
    const readers = [...(readsByAnn.get(a.id) || new Set<string>())].filter(n => storesForPerson.has(n));
    return {
      date: a.date, author: a.author,
      kind: a.doc_only ? 'Document' : a.high_priority ? 'High Priority' : 'Announcement',
      text: plainText(a.message, 120),
      readers: readers.length, audience: audienceSize, p: pct(readers.length, audienceSize),
    };
  }).sort((x: any, y: any) => x.p - y.p || x.date.localeCompare(y.date));

  // ONE list, every tracked surface in it, used or not — a separate "nobody
  // opened these" block meant reading the same names across two tables to work
  // out what happened to any one tool. Grouped in GROUPS order; inside a group
  // the busiest first, and everything untouched sinks to the bottom.
  const beaconTools = SURFACES.map(([k, label, group]) => {
    const t = toolUse.get(k);
    const cold = haveHistory && !t && !warmBefore.has(k);
    return {
      key: k, label, group,
      users: t ? t.users.size : 0,
      counts: pairsAtStore(k), denom: personDays,
      empty: cold ? 'Cold · 8 Days' : mode === 'day' ? 'Not Today' : 'Not Once',
      emptyKind: (cold ? 'bad' : 'plain') as 'bad' | 'plain',
    };
  })
    // Documents only earns a row when there is something to say: a document was
    // posted, or somebody went looking in the tab.
    .filter(t => t.key !== 'annDocsModal' || t.users > 0 || posted.some((a: any) => a.doc_only));

  const tools = [...annTools, ...beaconTools];
  const toolGroups = GROUPS.map(g => ({
    group: g,
    rows: tools.filter(t => t.group === g).sort((a, b) => b.users - a.users),
  })).filter(g => g.rows.length);
  const usedTools = tools.filter(t => t.users > 0);
  const untouched = tools.filter(t => t.users === 0);

  // ---- store comments ----
  const readsByComment = new Map<string, Set<string>>();
  (commentReadsQ.data || []).forEach((r: any) => {
    if (!readsByComment.has(r.comment_id)) readsByComment.set(r.comment_id, new Set());
    readsByComment.get(r.comment_id)!.add(norm(r.user_name));
  });
  const commentRows = (commentsQ.data || []).map((c: any) => {
    const s = String(c.store || '').toUpperCase();
    const roster = rows[s] ? rows[s].roster : [];
    const read = readsByComment.get(c.id) || new Set();
    const unread = roster.filter((u: any) => !read.has(norm(u.name))).map((u: any) => firstName(u.name));
    return {
      store: s, author: c.author, date: c.date,
      text: plainText(c.message, 140),
      readCount: roster.length - unread.length, total: roster.length, unread,
      p: pct(roster.length - unread.length, roster.length),
    };
  }).filter((c: any) => STORES.includes(c.store));

  // Day: every comment, in district order. Week/month: the worst read first,
  // trimmed — a month of comments is a wall, and the ones everybody read are
  // not the ones worth an email.
  const commentsShown = mode === 'day'
    ? [...commentRows].sort((a: any, b: any) => STORES.indexOf(a.store) - STORES.indexOf(b.store))
    : [...commentRows].sort((a: any, b: any) => a.p - b.p || a.date.localeCompare(b.date));

  // NOTE for anyone adding a "who did this" row from kpi_entries: that table's
  // `submitted_by` holds the submitter's PIN, not their name — the only table on
  // the site that does. Resolve it through pinToUser and never print it raw, or
  // the email leaks a live login credential.

  const expectedTotal = STORES.reduce((a, s) => a + rows[s].expected, 0);
  const activeTotal = STORES.reduce((a, s) => a + rows[s].active, 0);
  const engagedTotal = STORES.reduce((a, s) => a + rows[s].engaged, 0);

  // The strip along the bottom. A day report has no days of its own to draw, so
  // it reads back the stored snapshots; week and month already computed theirs.
  const trend = mode === 'day'
    ? (snapsQ.data || []).map((r: any) => ({
        label: shortDay(r.day).split(',')[0],
        pct: r.payload && r.payload.coveragePct != null ? Number(r.payload.coveragePct) : null,
      })).reverse()
    : mode === 'week'
      ? perDay.map(d => ({ label: shortDay(d.day).split(',')[0], pct: d.expected ? pct(d.active, d.expected) : null }))
      : (() => {
          // A month of daily bars is unreadable, so they roll up by week.
          // Labelled by the bucket's first day INSIDE the month, not by its
          // Monday — the week holding the 1st usually starts in the month
          // before, and "Wk 1 · Jul 27" on an August report reads as a mistake.
          const byWeek = new Map<string, { a: number; e: number; first: string; n: number }>();
          perDay.forEach(d => {
            const m = mondayOf(d.day);
            const w = byWeek.get(m) || { a: 0, e: 0, first: d.day, n: 0 };
            w.a += d.active; w.e += d.expected; w.n++;
            byWeek.set(m, w);
          });
          // THE LAST FOUR WEEKS, always (Ethan 2026-08-09). Almost every month
          // opens and closes mid-week, so bucketing by Monday gave five or six
          // bars of which the outer ones were often a single day — a lone
          // Saturday drawn the same width as a six-day week and read as one.
          //
          // Buckets holding fewer than three of the month's open days are dropped
          // as too thin to compare, then the last four are taken. Coverage is a
          // PERCENTAGE, so a four- or five-day tail week is still directly
          // comparable to a six-day one; only the very short buckets were noise.
          // Checked across 2026–2027: this yields exactly four bars every month,
          // where "whole weeks only" left three in about a third of them.
          const all = [...byWeek.entries()].sort();
          const solid = all.filter(([, w]) => w.n >= 3);
          return (solid.length > 1 ? solid : all).slice(-4).map(([m, w], i) => ({
            label: 'Wk ' + (i + 1) + ' · ' + shortDay(m.slice(0, 7) === endDay.slice(0, 7) ? m : w.first).split(', ')[1],
            pct: w.e ? pct(w.a, w.e) : null,
          }));
        })();

  return {
    mode, endDay, days,
    rows, rosterSize, expectedTotal, activeTotal, engagedTotal,
    coveragePct: pct(activeTotal, expectedTotal),
    toolGroups, usedTools, untouched,
    commentsShown, worstAnn, audienceSize,
    trend,
    worstN: mode === 'month' ? 5 : 3,
    sunday: mode === 'day' && isSunday(endDay),
  };
}

// ---------- shared HTML pieces (email-safe: tables + inline styles) ----------
const heroTile = () => {
  const bar = (h: number) =>
    `<td width="4" valign="bottom" style="padding:0 2px;"><div style="width:4px;height:${h}px;background:#6ee7a7;border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td>`;
  return `<table role="presentation" width="40" height="40" cellpadding="0" cellspacing="0" style="background:rgba(31,157,87,.20);border-radius:12px;"><tr><td align="center" valign="middle" height="40">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${bar(8)}${bar(16)}${bar(12)}</tr></table>
  </td></tr></table>`;
};

const wrapEmail = (title: string, accent: string, range: string, body: string, foot: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media only screen and (max-width:520px){.gtile{display:block!important;width:100%!important;padding:6px 0!important}.hide-sm{display:none!important}}</style></head>
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
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:22px;">${body}</td></tr>
  <tr><td style="padding:16px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.footBg};">${foot}</td></tr>
</table></td></tr></table></body></html>`;

const sectionLabel = (t: string, note = '') =>
  `<div style="margin:26px 2px 12px;border-left:2px solid ${C.sage};padding-left:11px;">
     <div style="font-size:15.5px;font-weight:800;color:${C.charcoal};letter-spacing:-.015em;">${t}</div>
     ${note ? `<div style="font-size:11px;font-weight:600;color:${C.faint};margin-top:2px;">${note}</div>` : ''}
   </div>`;

// Two tiles, centred. A tile with nothing to say underneath the number keeps
// the empty line as a non-breaking space rather than dropping the div — without
// it the two boxes sit at different heights side by side.
const tile = (label: string, value: string, sub: string, color = C.charcoal) =>
  `<td class="gtile" width="50%" valign="top" style="padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:${C.rBox}px;"><tr><td align="center" style="padding:16px 14px;text-align:center;">
    <div style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.5px;color:${C.faint};text-align:center;">${label}</div>
    <div style="font-size:26px;font-weight:900;color:${color};margin-top:5px;text-align:center;">${value}</div>
    <div style="font-size:11px;font-weight:700;color:${C.muted};margin-top:3px;text-align:center;">${sub || '&nbsp;'}</div>
  </td></tr></table></td>`;

// `w` sets an explicit column width as a real HTML attribute, not CSS: Outlook
// renders through Word, which ignores table-layout:fixed but does honour width=.
// Only needed where several separate tables have to line up with each other.
const th = (t: string, align = 'center', cls = '', w = '') => `<th class="${cls}"${w ? ` width="${w}"` : ''} style="font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:${C.faint};background:${C.soft};padding:9px 7px;text-align:${align};border-bottom:1px solid ${C.line};">${t}</th>`;
const badge = (s: string) => `<span style="display:inline-block;background:${STORE_TINT[s]};color:${STORE_COLOR[s]};border:1px solid ${STORE_RING[s]};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${s}</span>`;
// The same badge, greyed: this store is in the list but didn't do the thing.
const badgeOff = (s: string) => `<span style="display:inline-block;background:${C.card};color:#c3cbd1;border:1px solid ${C.line};font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;letter-spacing:.5px;">${s}</span>`;

const chip = (text: string, kind: 'bad' | 'warn' | 'ok' | 'plain') => {
  const m = {
    bad: ['#fcecec', '#b23636', '#f6d5d5'],
    warn: [C.flagHead, C.flagInk, C.flagBorder],
    ok: [C.tint, '#146c3c', '#c6ecd6'],
    plain: [C.soft, C.muted, C.line],
  }[kind];
  return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;background:${m[0]};color:${m[1]};border:1px solid ${m[2]};margin:3px 4px 0 0;">${text}</span>`;
};

// Names laid out two to a row in a real table, each pill filling its cell, so
// every pill is the same width and the two columns line up. Free-flowing
// inline-block chips wrap at whatever width the name happens to be, which reads
// as ragged the moment there are more than three or four.
//
// An entry may carry a second line. Over a week or a month the pill has to say
// how often it happened, and running that onto the name as "· 3d" read as a
// code rather than a fact (Ethan 2026-08-09). On its own line, lighter and
// spelled out, it is a sentence: the name is who, the line under it is how bad.
type ChipItem = string | { main: string; sub?: string };
const chipGrid = (names: ChipItem[], kind: 'bad' | 'warn' | 'ok' | 'plain') => {
  const m = {
    bad: ['#fcecec', '#b23636', '#f6d5d5'],
    warn: [C.flagHead, C.flagInk, C.flagBorder],
    ok: [C.tint, '#146c3c', '#c6ecd6'],
    plain: [C.soft, C.muted, C.line],
  }[kind];
  const cell = (n?: ChipItem) => {
    const it = typeof n === 'string' ? { main: n, sub: '' } : n;
    return `<td width="50%" valign="top" style="padding:4px 3px 0 0;">${it
      ? `<div style="font-size:11px;font-weight:700;padding:4px 10px;border-radius:99px;background:${m[0]};color:${m[1]};border:1px solid ${m[2]};text-align:center;line-height:1.4;">${esc(it.main)}${it.sub
        ? `<div style="font-size:10px;font-weight:600;opacity:.72;">${esc(it.sub)}</div>` : ''}</div>`
      : '&nbsp;'}</td>`;
  };
  const out: string[] = [];
  for (let i = 0; i < names.length; i += 2) out.push(`<tr>${cell(names[i])}${cell(names[i + 1])}</tr>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${out.join('')}</table>`;
};

function rowsBox(rowsHtml: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;overflow:hidden;">${rowsHtml}</table>`;
}

// A progress bar built from two table cells — no divs with percentage widths,
// which Outlook ignores.
const meter = (p: number, color: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.track};border-radius:99px;"><tr><td style="background:${color};height:8px;width:${Math.max(0, Math.min(100, p))}%;border-radius:99px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>`;

// ---------- build ----------
function buildReport(d: any) {
  const mode: Mode = d.mode;
  const isDay = mode === 'day';
  const noun = isDay ? 'today' : mode === 'week' ? 'this week' : 'this month';
  const title = isDay ? 'Daily Site Usage' : mode === 'week' ? 'Weekly Site Usage' : 'Monthly Site Usage';
  const range = isDay ? prettyDay(d.endDay)
    : mode === 'week' ? `${shortDay(d.days[0])} – ${shortDay(d.endDay)}`
    // The month, and nothing else (Ethan 2026-08-09). The report always runs on
    // the month's last open day, so "through Sat, Aug 30" was stating the rule
    // rather than an exception — and it made the header read like a partial month.
    : monthLabel(d.endDay);
  const parts: string[] = [];

  // ---- 1. coverage headline ----
  if (!d.sunday) {
    parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${tile('Expected', String(d.expectedTotal), isDay ? '' : `Over ${plural(d.days.length, 'Open Day')}`)}
      ${tile('Signed in', String(d.activeTotal), `${Math.round(d.coveragePct)}% Coverage`, pctColor(d.coveragePct))}
    </tr></table>`);

    const covRows = STORES.map(s => {
      const r = d.rows[s];
      const p = pct(r.active, r.expected);
      // Day: a flag when the sheet was never filled in. Week/month: how many of
      // the period's days were, since "not set" is now a matter of degree.
      const flag = isDay
        ? (r.daysRolesSet ? '' : chip('Roles Not Set', 'warn'))
        : (r.daysRolesSet === r.daysTotal ? '' : chip(`${plural(r.daysTotal - r.daysRolesSet, 'Day')} No Roles`, 'warn'));
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid ${C.line2};white-space:nowrap;">${badge(s)} <span style="font-size:12px;font-weight:700;color:${C.charcoal};">${STORE_NAME[s]}</span></td>
        <td style="padding:10px 4px;border-bottom:1px solid ${C.line2};white-space:nowrap;">${flag}</td>
        <td align="center" style="padding:10px 8px;border-bottom:1px solid ${C.line2};font-size:13px;font-weight:900;color:${C.charcoal};">${r.active}<span style="color:${C.faint};font-weight:700;"> / ${r.expected}</span></td>
        <td align="center" class="hide-sm" style="padding:10px 8px;border-bottom:1px solid ${C.line2};font-size:13px;font-weight:800;color:${C.muted};">${r.engaged}</td>
        <td style="padding:10px 12px;border-bottom:1px solid ${C.line2};width:130px;">
          ${meter(p, pctColor(p))}
          <div style="font-size:10.5px;font-weight:800;color:${pctColor(p)};margin-top:4px;">${Math.round(p)}%</div>
        </td></tr>`;
    }).join('');
    // The "roles not set" flag gets its own (unheaded) column rather than
    // trailing the store name — otherwise the pill starts at a different x on
    // every row, following the length of the store's name.
    // No note under the header on any of the three (Ethan 2026-08-09). The
    // person-days explanation was answering a question the column heads already
    // answer — "In / Expected" over a period can only mean person-days.
    parts.push(sectionLabel('Coverage By Store') +
      rowsBox(`<tr>${th('Store', 'left')}${th('', 'left')}${th('In / Expected')}${th('Used A Tool', 'center', 'hide-sm')}${th('Coverage')}</tr>${covRows}`));
  }

  // ---- 2. site usage overview ----
  // Grouped by KIND of problem, not by store. Per-store it ran to four rows a
  // store — twenty blocks to read before you knew whether anything was actually
  // wrong. One row per problem, with the stores on each name, says the same
  // thing in a glance.
  if (!d.sunday) {
    // One entry per PERSON, not per store, and not per day. The Multi-Store
    // Manager belongs to two rosters, so he would otherwise appear twice under
    // two different stores; here he reads once, with both store badges on him.
    const collect = (pick: (r: any) => Map<string, number>) => {
      const stores = new Map<string, string[]>();
      const count = new Map<string, number>();
      const outOf = new Map<string, number>();
      for (const s of STORES) pick(d.rows[s]).forEach((n: number, name: string) => {
        stores.set(name, [...(stores.get(name) || []), s]);
        count.set(name, Math.max(count.get(name) || 0, n));
        // Days that person was staffed at that store. Falls back to the store's
        // days-with-roles for the unaccounted list, which is only ever counted
        // on a day the sheet was filled in.
        const dd = d.rows[s].dueDays?.get(name) || d.rows[s].daysRolesSet || 0;
        outOf.set(name, Math.max(outOf.get(name) || 0, dd));
      });
      // Stores alphabetical, not district order — "BAL, MPL" rather than the
      // "MPL, BAL" that iterating STORES would produce.
      return [...stores.entries()]
        .map(([name, ss]) => ({ name, stores: ss.sort(), n: count.get(name) || 1, of: outOf.get(name) || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
    };

    // Day: names as pills, because a name and a store code is the whole fact.
    //
    // Week and month: a real TABLE with column heads (Ethan 2026-08-09). The pill
    // carried "Zach Marbs · BAL, LEE" over "Missed 3 Of 5 Days" and nobody could
    // tell what the 5 belonged to — the person, the store, or the report. Two
    // headed numeric columns say it outright: how many days this happened TO THIS
    // PERSON, and how many days they were on the schedule. The store column is
    // then plainly just where they work.
    const flag = (
      heading: string, note: string, rows: any[], kind: 'bad' | 'warn' | 'plain',
      countHead: string, ofHead: string,
    ) => {
      if (!rows.length) return '';
      // The three tables are separate <table>s inside separate rows, so nothing
      // makes their columns agree unless the widths are stated. Left to size
      // themselves each one landed its numbers at a different x and the block
      // read as three unrelated lists (Ethan 2026-08-09). The two numeric columns
      // are equal and wide, because the HEADS are the widest thing in them.
      const W = ['30%', '22%', '24%', '24%'];
      const body = isDay
        ? chipGrid(rows.map(r => `${r.name} · ${r.stores.join(', ')}`), kind)
        : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-top:1px solid ${C.line2};table-layout:fixed;">
            <tr>${th('Person', 'left', '', W[0])}${th('Store', 'left', '', W[1])}${th(countHead, 'center', '', W[2])}${th(ofHead, 'center', '', W[3])}</tr>
            ${rows.map(r => `<tr>
              <td width="${W[0]}" style="padding:8px 8px 8px 0;font-size:12px;font-weight:700;color:${C.charcoal};">${esc(r.name)}</td>
              <td width="${W[1]}" style="padding:8px 8px;">${r.stores.map((s: string) => badge(s)).join(' ')}</td>
              <td width="${W[2]}" align="center" style="padding:8px;font-size:13px;font-weight:900;color:${kind === 'bad' ? C.red : C.amber};">${r.n}</td>
              <td width="${W[3]}" align="center" style="padding:8px;font-size:13px;font-weight:800;color:${C.muted};">${r.of || '—'}</td>
            </tr>`).join('')}
          </table>`;
      return `<tr><td style="padding:12px 14px;border-bottom:1px solid ${C.line2};">
        <div style="font-size:12.5px;font-weight:800;color:${kind === 'bad' ? C.red : C.charcoal};">${heading} <span style="color:${C.faint};font-weight:700;">· ${rows.length}</span></div>
        <div style="font-size:11px;color:${C.muted};font-weight:600;margin-top:1px;">${note}</div>
        ${body}</td></tr>`;
    };

    const missing = flag('Expected In, Never Signed In', 'Given a working role, no activity recorded.',
        collect((r: any) => r.missed), 'bad', 'Days Missed', 'Days Scheduled')
      + flag('Signed In, Used Nothing', 'Here, but opened none of the tools below.',
        collect((r: any) => r.idle), 'warn', 'Days Idle', 'Days Scheduled')
      // The denominator here is the store's, not the person's: they were never put
      // on the schedule at all, so "days on the schedule" would read 0 for everyone.
      // What it can be measured against is how many days that store filled the sheet
      // in — the days it was possible to notice they were missing from it.
      + flag('No Role And No Off Day', "On the roster, given neither a role nor an off day, and never signed in — so we can't tell whether they were meant to be here.",
        collect((r: any) => r.unaccounted), 'warn', 'Days Unaccounted', 'Days Roles Were Set');

    parts.push(sectionLabel('Site Usage Overview') + (missing
      ? rowsBox(missing)
      : rowsBox(`<tr><td style="padding:14px;font-size:12.5px;color:${C.muted};">Everyone expected signed in and used something, and every roster name had a role or an off day. Nothing to chase.</td></tr>`)));
  }

  // ---- 3. tool usage ----
  // Every tracked surface in one grouped table, used and unused together, so a
  // tool is looked up in one place rather than two. Announcements sit here too
  // now, as read counts, instead of the old section that quoted every post.
  // Five fixed cells, always in district order, so the badges and the ratios line
  // up in columns down the whole table. Each row brings its OWN denominator: a
  // beacon tool is measured in staffed person-days (the same unit as the coverage
  // table), an announcement in post × person chances to read it. On a daily
  // report both collapse to people, which is what they always were.
  const storeCells = (counts: Record<string, number>, denom: Record<string, number>) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${STORES.map(s => {
      const n = counts[s] || 0, tot = denom[s] || 0;
      const p = pct(n, tot);
      return `<td align="center" width="20%" valign="top" style="padding:0 2px;">
        ${n ? badge(s) : badgeOff(s)}
        <div style="font-size:11px;font-weight:800;color:${n ? pctColor(p) : C.faint};margin-top:4px;">${n}/${tot}</div>
      </td>`;
    }).join('')}</tr></table>`;

  const toolRows = d.toolGroups.map((g: any) => {
    const head = `<tr><td colspan="3" style="padding:8px 12px;background:${C.soft};border-bottom:1px solid ${C.line};font-size:10px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:${C.muted};">${esc(g.group)}</td></tr>`;
    const body = g.rows.map((t: any) => {
      const on = t.users > 0;
      // Nothing at all gets the reason instead of five zeroes: "cold", "not once"
      // and "none posted" say different things, and a row of 0/4s says none of them.
      const right = on ? storeCells(t.counts, t.denom) : chip(t.empty, t.emptyKind);
      return `<tr>
        <td style="padding:11px 12px;border-bottom:1px solid ${C.line2};font-size:12.5px;font-weight:${on ? 700 : 600};color:${on ? C.charcoal : C.faint};">${esc(t.label)}</td>
        <td align="center" valign="middle" style="padding:11px 8px;border-bottom:1px solid ${C.line2};font-size:13px;font-weight:900;color:${on ? C.charcoal : C.faint};">${on ? t.users : '—'}</td>
        <td align="right" valign="middle" width="290" style="padding:9px 12px;border-bottom:1px solid ${C.line2};">${right}</td>
      </tr>`;
    }).join('');
    return head + body;
  }).join('');
  parts.push(sectionLabel('Tool Usage',
    `${d.usedTools.length} of ${d.usedTools.length + d.untouched.length} used ${noun}. ${isDay
      ? 'Each store shows how many of its people used it, against how many were on the floor.'
      : 'Each store is counted the same way its coverage is — days on the floor with the tool used on them, against every day it could have been. Announcements count chances to read a post rather than days.'} A tool counts once someone has actually used it — opened it, activated it, or done something with it. Reaching the page or tab an interactive tool sits on is not use, and is not recorded.`) +
    rowsBox(`<tr>${th('Tool', 'left')}${th('People')}${th('By Store', 'right')}</tr>${toolRows}`));

  // ---- 4. announcements least read (week and month only) ----
  // A day's posts are already summarised in the table above. Over a week or a
  // month what matters is which specific ones went unread, and when.
  if (!isDay && d.worstAnn.length) {
    const annHtml = d.worstAnn.slice(0, d.worstN).map((a: any) => `<tr><td style="padding:13px 14px;border-bottom:1px solid ${C.line2};">
      <table role="presentation" width="100%"><tr>
        <td style="font-size:11px;font-weight:800;color:${C.muted};">${esc(a.kind)} <span style="color:${C.faint};font-weight:600;">· ${shortDay(a.date)}</span></td>
        <td align="right" valign="top" style="white-space:nowrap;font-size:13px;font-weight:900;color:${pctColor(a.p)};padding-left:10px;">${a.readers}/${a.audience}</td>
      </tr></table>
      <div style="font-size:11.5px;color:${C.charcoal};font-weight:600;margin:8px 0 0;line-height:1.45;">${esc(a.text)}</div>
      <div style="font-size:10.5px;font-weight:600;color:${C.faint};margin-top:6px;">${esc(a.author || '')} · ${Math.round(a.p)}% of the company read it</div>
    </td></tr>`).join('');
    parts.push(sectionLabel('Announcements, Least Read',
      `The ${Math.min(d.worstN, d.worstAnn.length)} fewest-read posts of ${d.worstAnn.length} put out ${noun}.`) + rowsBox(annHtml));
  }

  // ---- 5. store comments ----
  // Still its own section: a comment is one person's message to one store, so
  // what matters is which store and who hasn't seen it — neither of which
  // survives being flattened into a district-wide count. A comment everybody
  // has read still gets a row, reading 4/4 in green; the point is the count,
  // not only the stragglers.
  const shown = isDay ? d.commentsShown : d.commentsShown.slice(0, d.worstN);
  const cmtHtml = shown.map((c: any) => `<tr><td style="padding:13px 14px;border-bottom:1px solid ${C.line2};"><table role="presentation" width="100%"><tr><td style="font-size:12.5px;color:${C.charcoal};">${badge(c.store)} <b>${esc(c.author)}</b>${isDay ? '' : ` <span style="font-size:10.5px;font-weight:600;color:${C.faint};">· ${shortDay(c.date)}</span>`}</td><td align="right" valign="top" style="white-space:nowrap;font-size:13px;font-weight:900;color:${c.unread.length ? C.amber : C.green};padding-left:10px;">${c.readCount}/${c.total}</td></tr></table><div style="font-size:11.5px;color:${C.muted};font-weight:600;margin:9px 0 0;line-height:1.45;">${esc(c.text)}</div>${c.unread.length ? `<div style="font-size:10.5px;font-weight:700;color:${C.faint};margin-top:14px;">Not Yet Read By:</div><div style="margin-top:5px;">${c.unread.map((u: string) => chip(esc(u), 'warn')).join('')}</div>` : `<div style="font-size:10.5px;font-weight:700;color:${C.faint};margin-top:14px;">Read By Everyone At ${c.store}</div>`}</td></tr>`).join('');
  parts.push(sectionLabel(isDay ? 'Store Comments' : 'Store Comments, Least Read',
    // Worded like the announcements note above it, with "comments" for "posts" —
    // two sections doing the same job should not need reading twice (Ethan).
    isDay ? '' : `The ${Math.min(d.worstN, d.commentsShown.length)} fewest-read comments of ${d.commentsShown.length} left ${noun}.`) +
    (shown.length ? rowsBox(cmtHtml)
      : rowsBox(`<tr><td style="padding:14px;font-size:12.5px;color:${C.muted};">No store comments ${noun}.</td></tr>`)));

  // ---- 6. action menu items ----
  // The obligations that surface as cards in the Action Menu. Counts are items
  // recorded, not people — a store with more checklist items than another is
  // expected, and who ticked them is a manager's question, not this email's.
  const ratio = (done: number, total: number) => {
    const p = pct(done, total);
    const col = !done ? C.red : done >= total ? C.green : C.charcoal;
    return `<span style="color:${col};">${done}</span><span style="color:${C.faint};font-weight:700;">/${total}</span>`;
  };
  // Week and month stack lines in one cell rather than adding columns — two more
  // would have pushed this table past the width of the email.
  const pctLine = (label: string, done: number, total: number, lead = false) => {
    const p = pct(done, total);
    return `<div style="font-size:${lead ? 11.5 : 10}px;font-weight:${lead ? 800 : 700};color:${pctColor(p)};margin-top:${lead ? 0 : 3}px;">${label} ${Math.round(p)}%</div>`;
  };
  const periodRatio = (label: string, done: number, total: number) =>
    `<span style="font-size:11px;color:${C.muted};font-weight:700;">${label}</span> ${ratio(done, total)}`;

  const obRows = STORES.map(s => {
    const r = d.rows[s];
    const goalsChip = isDay
      ? (!r.daysRolesSet ? chip('Not Set', 'bad')
        : r.unaccounted.size ? chip(`${r.unaccounted.size} Unaccounted`, 'warn')
        : chip('Complete', 'ok'))
      : chip(`${r.daysRolesSet}/${plural(r.daysTotal, 'Day')} Set`, r.daysRolesSet === r.daysTotal ? 'ok' : 'warn');
    const monthChip = r.monthlyGoals
      ? chip(`${r.monthlyGoals} Monthly Goal${r.monthlyGoals === 1 ? '' : 's'}`, 'ok')
      : chip('Not Set', 'bad');

    // Day: one ratio. Week: the week's own list on top, the daily list under it.
    //
    // Month (Ethan 2026-08-09): the monthly list is a COUNT worth reading — it is
    // two or three items for the whole month — but daily and weekly over 26 open
    // days are ratios of hundreds, where only the percentage means anything. So
    // the month shows the monthly ratio, then both percentages.
    //
    // The cleaning checklist has no monthly cadence at all (audit_items are daily
    // or weekly), so on a monthly report it is the two percentages alone rather
    // than an invented monthly line.
    const clCell = isDay
      ? ratio(r.checklist.done, r.checklist.total)
      : mode === 'week'
        ? (r.checklistPeriod.total
            ? periodRatio('Weekly', r.checklistPeriod.done, r.checklistPeriod.total)
            : `<span style="font-size:11px;color:${C.faint};font-weight:700;">no weekly list</span>`)
          + pctLine('Daily', r.checklist.done, r.checklist.total)
        : (r.checklistPeriod.total
            ? periodRatio('Monthly', r.checklistPeriod.done, r.checklistPeriod.total)
            : `<span style="font-size:11px;color:${C.faint};font-weight:700;">no monthly list</span>`)
          + pctLine('Daily', r.checklist.done, r.checklist.total)
          + pctLine('Weekly', r.checklistWeekly.done, r.checklistWeekly.total);
    const cnCell = isDay
      ? ratio(r.cleaning.done, r.cleaning.total)
      : mode === 'week'
        ? periodRatio('Weekly', r.cleaningPeriod.done, r.cleaningPeriod.total)
          + pctLine('Daily', r.cleaning.done, r.cleaning.total)
        : pctLine('Daily', r.cleaning.done, r.cleaning.total, true)
          + pctLine('Weekly', r.cleaningPeriod.done, r.cleaningPeriod.total);

    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid ${C.line2};">${badge(s)}</td>
      <td align="center" style="padding:10px 6px;border-bottom:1px solid ${C.line2};">${goalsChip}</td>
      <td align="center" style="padding:10px 6px;border-bottom:1px solid ${C.line2};font-size:12px;font-weight:800;">${clCell}</td>
      <td align="center" style="padding:10px 6px;border-bottom:1px solid ${C.line2};font-size:12px;font-weight:800;">${cnCell}</td>
      <td align="center" style="padding:10px 6px;border-bottom:1px solid ${C.line2};">${monthChip}</td>
    </tr>`;
  }).join('');
  parts.push(sectionLabel('Action Menu Items',
    isDay ? ''
      : mode === 'week'
        ? `The week's own list on top, the daily list added up across all ${plural(d.days.length, 'open day')} underneath.`
        : `Counts for the monthly lists, percentages for the daily and weekly ones — over ${plural(d.days.length, 'open day')} those are ratios of hundreds.`) +
    rowsBox(`<tr>${th('Store', 'left')}${th('Listing Goals')}${th('Checklist')}${th('Cleaning Checklist')}${th('Monthly Goals')}</tr>${obRows}`));

  // ---- 7. trend ----
  // Week and month only (Ethan 2026-08-09). On a daily email the strip was a
  // second, quieter answer to the question the two tiles at the top had already
  // answered loudly, and the trailing week it drew is the weekly report's whole
  // job. Week and month keep theirs: those bars are days and weeks INSIDE the
  // period being reported, not a lookback next to it.
  const withPct = isDay ? [] : d.trend.filter((t: any) => t.pct != null);
  if (withPct.length > 1) {
    const bars = withPct.map((t: any) =>
      `<td align="center" valign="bottom" style="padding:0 4px;"><div style="font-size:10px;font-weight:800;color:${pctColor(t.pct)};">${Math.round(t.pct)}%</div><div style="width:100%;height:${Math.max(3, Math.round(t.pct * 0.44))}px;background:${pctColor(t.pct)};border-radius:3px 3px 0 0;font-size:0;line-height:0;">&nbsp;</div><div style="font-size:10px;font-weight:700;color:${C.faint};padding-top:4px;">${esc(t.label)}</div></td>`).join('');
    parts.push(sectionLabel(mode === 'week' ? 'Coverage, Day By Day' : 'Coverage, Week By Week', '') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:${C.rBox}px;"><tr><td style="padding:16px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:60px;"><tr valign="bottom">${bars}</tr></table></td></tr></table>`);
  }

  const foot = d.sunday
    ? 'Generated automatically by Speeks · Sunday: stores closed, so coverage is not reported.'
    : `Generated automatically by Speeks · ${isDay ? 'midnight to 8:00pm Central' : `${plural(d.days.length, 'open day')}, Sundays excluded, through 8:00pm Central`}. CORP and the shop-floor boards are excluded throughout. Only the tools listed above are tracked.`;
  return wrapEmail(title, C.sage, range, parts.join(''), foot);
}

// ---------- send (Gmail relay preferred, Resend fallback) ----------
async function sendEmail(to: string[], subject: string, html: string) {
  if (GMAIL_RELAY) {
    const res = await fetch(GMAIL_RELAY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, to: to.join(','), subject, html }),
    });
    const txt = await res.text();
    return { ok: res.ok, status: res.status, body: txt.slice(0, 300) };
  }
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

async function recipients(sb: any): Promise<string[]> {
  try {
    const { data } = await sb.from('email_recipients').select('email').eq('list_key', LIST_KEY);
    const list = (data ?? []).map((r: any) => r.email).filter(Boolean);
    return list.length ? list : FALLBACK_TO;
  } catch (_e) { return FALLBACK_TO; }
}

// One row per store plus ALL. Keeps the numbers after usage_events is pruned,
// and is what the daily trend strip reads back. Only the daily run writes: a
// week and a month are re-derivable from the days, and a rollup landing in the
// same table would be double-counted by the strip.
async function writeSnapshot(sb: any, d: any) {
  const recs = STORES.map(s => {
    const r = d.rows[s];
    return {
      day: d.endDay, store: s,
      payload: {
        expected: r.expected, active: r.active, engaged: r.engaged,
        coveragePct: r.expected ? pct(r.active, r.expected) : null,
        rolesSet: r.daysRolesSet > 0, unaccounted: r.unaccounted.size,
        checklist: r.checklist.done, checklistTotal: r.checklist.total,
        cleaning: r.cleaning.done, cleaningTotal: r.cleaning.total,
        monthlyGoals: r.monthlyGoals,
      },
    };
  });
  recs.push({
    day: d.endDay, store: 'ALL',
    payload: {
      expected: d.expectedTotal, active: d.activeTotal, engaged: d.engagedTotal,
      coveragePct: d.expectedTotal ? d.coveragePct : null,
      tools: d.usedTools.map((t: any) => ({ key: t.key, users: t.users })),
      untouched: d.untouched.map((u: any) => u.key),
    },
  } as any);
  await sb.from('usage_daily_snapshots').upsert(recs, { onConflict: 'day,store' });
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
    const day = q('day') || centralToday();
    const m = String(q('mode') || 'day').toLowerCase();
    const mode: Mode = m === 'week' || m === 'month' ? m : 'day';
    const dryRun = q('dryRun') === '1';
    const overrideTo = q('to');

    const d = await gather(sb, day, mode);
    const html = buildReport(d);
    if (dryRun) return new Response(html, { headers: { 'Content-Type': 'text/html' } });

    const to = overrideTo ? [overrideTo] : await recipients(sb);
    const label = mode === 'day' ? `Daily Site Usage — ${prettyDay(day)}`
      : mode === 'week' ? `Weekly Site Usage — ${shortDay(d.days[0])} to ${shortDay(day)}`
      : `Monthly Site Usage — ${monthLabel(day)}`;
    const subject = `${label}${d.sunday ? '' : ` — ${d.activeTotal}/${d.expectedTotal} (${Math.round(d.coveragePct)}%)`}`;
    const sent = await sendEmail(to, subject, html);

    if (mode === 'day') {
      await writeSnapshot(sb, d);
      // Raw events past 90 days are gone; the daily snapshots carry the history.
      const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - 90);
      await sb.from('usage_events').delete().lt('day', cutoff.toISOString().slice(0, 10));
    }

    return new Response(JSON.stringify({ ok: true, mode, day, days: d.days.length, to, sent, expected: d.expectedTotal, active: d.activeTotal }, null, 2), { headers: cors });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? '').slice(0, 700) }), { status: 500, headers: cors });
  }
});
