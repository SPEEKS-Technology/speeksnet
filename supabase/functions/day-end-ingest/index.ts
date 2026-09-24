// ============================================================================
// day-end-ingest — banks the nightly PayMore Day End Report into day_end_facts.
//
// Flow:  pg_cron  ->  this function  ->  Apps Script ?action=dayEndFacts
//        ->  day_end_facts  ->  (next) daily-brief  ->  comment_drafts
//
// Why a second feed at all, when sales-ingest already reads the same emails:
// sales-ingest writes the SHEET, and the sheet only carries est_value, margin
// and net sales. Everything the DM's daily messages actually react to —
// customer conversion, Devices Processed ("listed items"), MTD 5-star reviews,
// Total Customers, and the per-person Team Production table — is thrown away at
// that step because the sheet has nowhere to put it. This lands the whole
// report, once, keyed by (store, date).
//
// Both feeds read the same email and must agree where they overlap:
// day_end_facts.est_value == daily_buysell.buy (Estimated Value, the resale
// value bought — NOT cash paid, which is total_spent and exists only here).
// The mismatch check below tests exactly that and is the cheapest smoke test
// that a template change has not silently moved a column.
//
// Idempotent: upsert on (store, date), so re-running over the same window is
// free. That is what makes the one-time history backfill safe to repeat.
//
// WHEN IT RUNS: 5:05am Central (jobid 29, hourly at :05, Central-hour guard=5).
// It was 7:05 until migration 0096 moved the morning chain to 6:05; this has to
// sit AHEAD of processed-report, which reads day_end_facts at 6:15 and fetches
// nothing of its own. There is room to be this early because the Day End Report
// mail lands at 19:00-19:01 the evening before — unlike the Daily Sales Report
// the sales import waits on, which is not sent until 06:00.
//
// It used to be TWO jobs with no Central-hour guard, so both fired daily (7:05
// and 8:05 in CDT). Harmless against an idempotent upsert, but in CST the
// earlier twin would have landed on 6:05 — the minute sales-ingest now takes
// the shared Apps Script lock, which is migration 0088's failure exactly. 0096
// gave jobid 29 the guard and deactivated jobid 30.
//
// Auth: verify_jwt=false, ?secret= only. There is no browser path — nothing in
// speeks.js calls this, and the secret must stay out of the frontend (it also
// guards weekly-report, which emails real store managers).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SECRET = "sp33ks-sync-k3y-2026-x9mq";

// The sales-email-import Apps Script web app. Editing that script does NOT
// change what this URL serves — a new deployment VERSION must be published, the
// same drift trap edge functions have. If `dayEndFacts` comes back as
// `unknown action`, that is the cause: the action exists in the editor but not
// in the deployed version.
const APPS_SCRIPT_URL = Deno.env.get("SALES_IMPORT_URL")
  || "https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec";

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

type Row = Record<string, unknown>;

// Apps Script camelCase -> column names. Explicit rather than derived: a typo
// in a derived mapper would silently drop a column, and a dropped column here
// means a threshold that never fires rather than an error anyone would see.
const FIELD_MAP: Record<string, string> = {
  cashSpent: "cash_spent",
  totalSpent: "total_spent",
  estValue: "est_value",
  estGrossProfit: "est_gross_profit",
  estMarginPct: "est_margin_pct",
  custConvNum: "cust_conv_num",
  custConvDen: "cust_conv_den",
  devConvNum: "dev_conv_num",
  devConvDen: "dev_conv_den",
  failedDeals: "failed_deals",
  devicesLost: "devices_lost",
  lostRevenue: "lost_revenue",
  grossSales: "gross_sales",
  netSales: "net_sales",
  salesMarginPct: "sales_margin_pct",
  newCustomers: "new_customers",
  returnCustomers: "return_customers",
  recycleCustomers: "recycle_customers",
  noDealCustomers: "no_deal_customers",
  browsingCustomers: "browsing_customers",
  totalCustomers: "total_customers",
  reviewsToday: "reviews_today",
  fiveStarToday: "five_star_today",
  fiveStarMtd: "five_star_mtd",
  devicesProcessed: "devices_processed",
  processedValue: "processed_value",
  // Listings created (0115). Absent from mail before 2026-09-23, which lands as
  // null here (toRow maps undefined to null), never a 0.
  listedDevices: "listed_devices",
  queueCount: "queue_count",
  availableCount: "available_count",
  availableCost: "available_cost",
  liveCount: "live_count",
  teamProduction: "team_production",
  shoutouts: "shoutouts",
};

// Same retry as sales-ingest, and for the same reason: /exec answers a 302 to
// script.googleusercontent.com, and that hop intermittently serves an HTML
// error page instead of our JSON. Nothing about the request is wrong, so the
// same request seconds later succeeds. Safe to retry because the read is
// read-only on the Gmail side and the write is an upsert on this side.
async function callAppsScript(target: URL, attempts = 3): Promise<any> {
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(target.toString(), { method: "POST", redirect: "follow" });
      const txt = await res.text();
      try {
        return JSON.parse(txt);
      } catch (_) {
        last = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
      }
    } catch (err) {
      last = `could not reach the Apps Script: ${String(err)}`;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, i * 4000));
  }
  return { ok: false, error: `Apps Script did not return usable JSON after ${attempts} attempts. Last response — ${last}` };
}

function toRow(src: Row): Row | null {
  const store = String(src.store ?? "");
  const date = String(src.date ?? "");
  if (!STORES.includes(store) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const out: Row = { store, date, source: src.source ?? null };
  for (const [from, to] of Object.entries(FIELD_MAP)) {
    const v = src[from];
    out[to] = v === undefined ? null : v;
  }
  const warnings = Array.isArray(src.warnings) ? src.warnings : [];
  out.parse_warnings = warnings.length ? warnings : null;
  out.captured_at = new Date().toISOString();
  return out;
}

// ---- Listing Goals results -------------------------------------------------
// listing_goals.result had never been written by anything — zero on every row
// since June (0097) — so the goals scoreboard showed goals and no results, and
// the manager-filed weekly KPI was the only listed figure anywhere. The Day End
// Report names every person with a count, so each goal row gets that person's
// figure for the day: Total Listed Devices from 2026-09-23 (0115), Devices
// Processed before then — the same listedOf() rule district-watch judges on, so
// the goals board and the DM matrix count the same thing.
//
// Written here, the morning after, and only for days the report covers. The
// manager's widget only ever saves TODAY, so the two never write the same row;
// listing-goals POST also stopped sending `result` for the same reason.
//
// NAMES: exact (case, spacing ignored), else the same surname with one first
// name the start of the other — "Jon Rodriguez" on the rota is "Jonathan
// Rodriguez" to PayMore. A name that matches two goal rows is left alone rather
// than guessed. Measured 2026-09-24 over 15 days: 197 of 237 report rows matched
// exactly one goal row, none matched two. The rest are people the rota does not
// carry (the Listers at OVL and MPL) or days no rota was saved; both come back
// in the response so the gap stays visible instead of silently scoring 0.
// The temps row the goals widget saves (speeks.js GOALS_TEMP_*): one row, goal 20 per temp, 0-2 temps.
const TEMP_ROLE = "TEMP";

const normName = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
function sameName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split(" "), pb = b.split(" ");
  if (pa.length < 2 || pb.length < 2 || pa[pa.length - 1] !== pb[pb.length - 1]) return false;
  const fa = pa[0], fb = pb[0];
  return fa.length > 2 && fb.length > 2 && (fa.startsWith(fb) || fb.startsWith(fa));
}

async function writeGoalResults(sb: any, rows: Row[], dry = false) {
  const withTeam = rows.filter((r) => Array.isArray(r.team_production) && (r.team_production as any[]).length);
  const out = { would_write: [] as string[], temp_assigned: [] as string[], updated: 0, unchanged: 0, unmatched_report: [] as string[], unmatched_rota: [] as string[], errors: [] as string[] };
  if (!withTeam.length) return out;

  const dates = [...new Set(withTeam.map((r) => String(r.date)))].sort();
  const { data: goals, error } = await sb.from("listing_goals")
    .select("store,date,employee,role,goal,result")
    .gte("date", dates[0]).lte("date", dates[dates.length - 1]);
  if (error) { out.errors.push(error.message); return out; }

  // Everyone with a SPEEKSNET account, for the temp rule below. Same name
  // rule as the rota match, so "Jonathan" in the report is still "Jon".
  const { data: users } = await sb.from("users").select("name");
  const userNames = (users || []).map((u: any) => normName(u.name)).filter(Boolean);
  const isUser = (n: string) => userNames.some((u: string) => sameName(u, n));

  const writes: any[] = [];
  for (const day of withTeam) {
    const team = (day.team_production as any[]).map((m) => ({
      n: normName(m.name),
      count: m.listed != null ? Number(m.listed) || 0 : Number(m.processed) || 0,
      used: false,
    }));
    const rota = (goals || []).filter((g: any) => g.store === day.store && g.date === day.date);
    for (const g of rota) {
      if (String(g.role || "").toUpperCase() === TEMP_ROLE) continue;   // below, once everyone else is placed
      const hits = team.filter((m) => sameName(normName(g.employee), m.n));
      if (hits.length > 1) continue;   // ambiguous: never guessed
      if (hits.length === 0) {
        // The report ran for this store-day and this person is not in it: they
        // listed nothing. Recorded as 0, not left null — null means "no report
        // read yet", and the widget would show that dash forever. A working
        // seat only; an Off row has nothing to score. The name is still
        // returned, because a spelling that drifted from PayMore's lands here too.
        if (Number(g.goal) > 0) {
          out.unmatched_rota.push(`${day.store} ${day.date} ${g.employee}`);
          if (g.result == null || Number(g.result) !== 0) {
            writes.push({ store: g.store, date: g.date, employee: g.employee, role: g.role, goal: g.goal, result: 0 });
          } else out.unchanged++;
        }
        continue;
      }
      hits[0].used = true;
      if (g.result != null && Number(g.result) === hits[0].count) { out.unchanged++; continue; }
      // role and goal ride along because the upsert is an insert-or-update on
      // (store,date,employee) and role is NOT NULL; they are the row's own values.
      writes.push({ store: g.store, date: g.date, employee: g.employee, role: g.role, goal: g.goal, result: hits[0].count });
    }
    // TEMPS. A temp lister has no SPEEKSNET account, so never a roster row of
    // their own; the manager sets how many temps are in (0-2) instead, which saves
    // one row with role TEMP carrying 20 per temp. That row's result is
    // everyone in the report who matched nobody on the rota AND is not a
    // SPEEKSNET user (Ethan, 2026-09-24: Jaime Shelton, Stephanie Holt, Sonia
    // Smith, jahmecca curry-slaughter — "those people don't need accounts").
    //
    // The account test is what keeps real staff out of it. Measured Aug 3 –
    // Sep 20, the unmatched names also include the DM listing on a store visit
    // and floaters listing at a store whose rota had them elsewhere; all of
    // them have accounts, so none of them is a temp. Names that land here are
    // returned in `temp_assigned` so a mistake cannot hide.
    const temp = rota.find((g: any) => String(g.role || "").toUpperCase() === TEMP_ROLE);
    if (temp) {
      const theirs = team.filter((m) => !m.used && m.count > 0 && !isUser(m.n));
      theirs.forEach((m) => { m.used = true; });
      const count = theirs.reduce((s, m) => s + m.count, 0);
      out.temp_assigned.push(`${day.store} ${day.date}: ${theirs.map((m) => `${m.n} (${m.count})`).join(", ") || "nobody"}`);
      if (temp.result == null || Number(temp.result) !== count) {
        writes.push({ store: temp.store, date: temp.date, employee: temp.employee, role: temp.role, goal: temp.goal, result: count });
      } else out.unchanged++;
    }
    // Only people with a goal row that day are worth naming here: someone who
    // listed and has no row is output the goals board cannot see.
    if (rota.length) {
      for (const m of team) if (!m.used && m.count > 0) out.unmatched_report.push(`${day.store} ${day.date} ${m.n} (${m.count})`);
    }
  }
  if (dry) {
    out.would_write = writes.map((w) => `${w.store} ${w.date} ${w.employee}: ${w.result}`);
    return out;
  }
  for (let i = 0; i < writes.length; i += 200) {
    const { error: e } = await sb.from("listing_goals").upsert(writes.slice(i, i + 200), { onConflict: "store,date,employee" });
    if (e) out.errors.push(e.message); else out.updated += Math.min(200, writes.length - i);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // ?goalsFrom=YYYY-MM-DD[&goalsTo=…][&dryRun=1] — re-run ONLY the Listing
  // Goals write, off the day_end_facts already banked, with no Gmail round
  // trip. For history (day_end_facts starts 2026-08-01, and every result before
  // 2026-09-21 was a 0 nobody wrote), and for a day whose rota was saved or
  // corrected after the morning run. Same function, so same matching rules.
  const goalsFrom = url.searchParams.get("goalsFrom");
  if (goalsFrom) {
    const goalsTo = url.searchParams.get("goalsTo") || new Date().toISOString().slice(0, 10);
    const { data: facts, error: fe } = await sb.from("day_end_facts")
      .select("store,date,team_production").gte("date", goalsFrom).lte("date", goalsTo);
    if (fe) {
      return new Response(JSON.stringify({ ok: false, error: fe.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const res = await writeGoalResults(sb, (facts || []) as Row[], url.searchParams.get("dryRun") === "1");
    return new Response(JSON.stringify({ ok: res.errors.length === 0, from: goalsFrom, to: goalsTo, days: (facts || []).length, goal_results: res }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Default 2 rather than 1: the report lands at 10pm for the same day, and a
  // store that closes late (or a night the mail is slow) would otherwise fall
  // through a 1-day window entirely. Overlap is free — the upsert absorbs it.
  const days = Math.max(1, parseInt(url.searchParams.get("days") ?? "2", 10) || 2);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const target = new URL(APPS_SCRIPT_URL);
  target.searchParams.set("action", "dayEndFacts");
  target.searchParams.set("secret", SECRET);
  target.searchParams.set("days", String(days));

  const report = await callAppsScript(target);
  if (!report?.ok) {
    return new Response(JSON.stringify({ ok: false, stage: "apps-script", error: report?.error ?? "unknown" }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const raw: Row[] = Array.isArray(report.rows) ? report.rows : [];
  const rows = raw.map(toRow).filter(Boolean) as Row[];
  const rejected = raw.length - rows.length;

  if (dryRun) {
    return new Response(JSON.stringify({
      ok: true, dryRun: true, days,
      messages_seen: report.messages_seen, parsed: raw.length, rejected,
      with_warnings: report.rows_with_warnings,
      sample: rows.slice(-5),
      // What the Listing Goals write WOULD do; nothing is written on a dry run.
      goal_results: await writeGoalResults(sb, rows, true),
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let written = 0;
  const errors: string[] = [];
  // Chunked: a full-history backfill is thousands of rows and one oversized
  // statement is the difference between a partial write and a clean retry.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await sb.from("day_end_facts").upsert(chunk, { onConflict: "store,date" });
    if (error) errors.push(error.message);
    else written += chunk.length;
  }

  // Each person's figure onto their Listing Goals row. After the facts upsert,
  // and only on rows that landed — a failed chunk leaves its days' goals alone.
  const goalResults = errors.length ? null : await writeGoalResults(sb, rows);

  // Cross-check against the feed that already exists. These two read the same
  // email by different routes, so a disagreement means a column moved — and
  // that is far easier to see here than as a threshold that quietly stopped
  // firing three weeks later.
  const mismatches: any[] = [];
  if (rows.length) {
    const dates = [...new Set(rows.map((r) => String(r.date)))].sort();
    const { data: bs } = await sb.from("daily_buysell")
      .select("store,date,buy").gte("date", dates[0]).lte("date", dates[dates.length - 1]);
    const byKey = new Map((bs ?? []).map((b: any) => [`${b.store}|${b.date}`, Number(b.buy)]));
    for (const r of rows) {
      const other = byKey.get(`${r.store}|${r.date}`);
      const mine = r.est_value == null ? null : Number(r.est_value);
      if (other == null || mine == null) continue;
      // Whole dollars on both sides; a cent of drift is rounding, not a bug.
      if (Math.abs(other - mine) > 1) {
        mismatches.push({ store: r.store, date: r.date, day_end_facts: mine, daily_buysell: other });
      }
    }
  }

  return new Response(JSON.stringify({
    ok: errors.length === 0,
    days,
    messages_seen: report.messages_seen,
    skipped: report.skipped,
    parsed: raw.length,
    rejected,
    written,
    with_warnings: report.rows_with_warnings,
    // Non-fatal. est_value disagreeing with daily_buysell.buy is the signal
    // that the Day End template changed; investigate before trusting a draft.
    est_value_mismatches: mismatches.slice(0, 20),
    mismatch_count: mismatches.length,
    goal_results: goalResults,
    errors,
  }, null, 2), {
    status: errors.length ? 500 : 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
