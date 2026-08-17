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
    errors,
  }, null, 2), {
    status: errors.length ? 500 : 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
