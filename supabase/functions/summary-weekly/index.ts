// ============================================================================
// summary-weekly — drives the Summary tab import on Monday mornings.
//
// Flow:  pg_cron  ->  this function  ->  sales-email-import.gs (?action=weekly)
//        ->  the "Summary" tab of the Sales Summary sheet.
//
// Its own function and its own cron pair rather than a rider on sales-ingest,
// and that separation is load-bearing: the daily import is idempotent, so a
// stray extra call costs nothing, while this run SHIFTS four week blocks up —
// an extra call would push a real week off the top of the running window. Being
// a different URL means nothing can reach it by accident.
//
// It also writes nothing to sales_ingest_runs. status() there serves the DM/CEO
// "last import" line by taking the newest row regardless of kind, so a Monday
// weekly run would present itself as the last DAILY import. The alert email is
// the visibility mechanism here.
//
// The week runs SUNDAY..SATURDAY, matching the period the PayMore weekly report
// covers. All the sheet work, Gmail reading and parsing lives in the Apps
// Script, which runs as the account that receives the emails and so needs no
// OAuth. This function owns orchestration and the alert only.
//
// Auth: verify_jwt=false, with two paths — ?secret= for pg_cron, and an
// x-user-pin header re-checked against the users table for the DM/CEO button.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Same machine secret as the rest of the chain. Never put it in speeks.js — it
// also guards weekly-report, which emails real store managers. The browser gets
// the pin path below instead.
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

// The button re-checks the REAL role by pin, because hiding a control in the
// frontend is not a security boundary. Mirrors sales-ingest; the users table
// stores "CEO" / "District Manager", hence the lowercasing.
const ADMIN_ROLES = ["ceo", "district manager"];

// The sales-email-import Apps Script web app. Shares SALES_IMPORT_URL with
// sales-ingest deliberately — there is one /exec serving both actions, and a
// redeploy that changed the URL must not leave the two pointing at different
// versions of the same script.
//
// NOTE: editing that Apps Script does not change what this URL serves. A new
// deployment VERSION has to be published — the same drift trap edge functions
// have.
const APPS_SCRIPT_URL = Deno.env.get("SALES_IMPORT_URL")
  || "https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec";

// Same relay the weekly report and the daily import send through — Apps Script
// plus GmailApp, so no DNS or sending domain to maintain.
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL")
  || "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

// Its OWN list, not the daily import's. `sales_import_alert` also carries the
// CEO, and this weekly alert is deliberately narrower (user, 2026-08-10) —
// sharing a key would have quietly widened the audience the first Monday
// something went wrong. Managed through the Email Recipients tool like the rest.
const ALERT_LIST_KEY = "summary_weekly_alert";
const ALERT_FALLBACK = ["ethan.kushnir@speekstechnology.com"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  let p: Record<string, string> = Object.fromEntries(url.searchParams.entries());
  if (req.method === "POST") {
    try {
      const b = await req.json();
      if (b && typeof b === "object") p = { ...p, ...b };
    } catch (_) { /* query params only */ }
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Two callers, two auth paths.
  if (p.secret === SECRET) {
    // pg_cron. Trust the params as given.
  } else {
    const pin = req.headers.get("x-user-pin") || "";
    if (!pin) return json({ ok: false, error: "unauthorized" }, 401);
    const { data: user } = await sb.from("users").select("name, role").eq("pin", pin).single();
    if (!user) return json({ ok: false, error: "Invalid PIN" }, 401);
    if (!ADMIN_ROLES.includes(String(user.role || "").toLowerCase().trim())) {
      return json({ ok: false, error: "Insufficient role" }, 403);
    }
    // A human clicking Run owns the outcome on screen, so never email an alert
    // for it — the alert exists for the unattended Monday run nobody is watching.
    //
    // The testing overrides are stripped too, deliberately: weekEnd and tab
    // point the run at a different week or a different sheet, and inPlace
    // suppresses the shift. They are for a console, not for a button that any
    // DM can press.
    p.actor = String(user.name || "");
    p.trigger = "manual";
    p.alert = "0";
    delete p.weekEnd; delete p.tab; delete p.inPlace; delete p.force;
  }

  return json(await runWeekly(sb, p));
});

async function runWeekly(sb: any, p: Record<string, string>) {
  const trigger = ["cron", "manual"].includes(p.trigger) ? p.trigger : "cron";
  const dryRun = p.dryRun === "1";

  // Alerts on its ONLY pass, unlike the daily pair. The daily first run stays
  // quiet because a Shopify email can genuinely still be in flight at 7am; by
  // Monday morning a Saturday report is not late, it is absent.
  const alerting = p.alert !== "0" && !dryRun;

  const target = new URL(APPS_SCRIPT_URL);
  target.searchParams.set("secret", SECRET);
  target.searchParams.set("action", "weekly");
  if (dryRun) target.searchParams.set("dryRun", "1");
  if (p.force === "1") target.searchParams.set("force", "1");
  if (p.inPlace === "1") target.searchParams.set("inPlace", "1");
  if (p.weekEnd) target.searchParams.set("weekEnd", p.weekEnd);
  if (p.tab) target.searchParams.set("tab", p.tab);

  const call = await callAppsScript(target);
  const report: any = call.report;
  const problems = weeklyProblems(report);

  let alert: any = null;
  if (alerting && problems.total) alert = await sendWeeklyAlert(sb, report, problems);

  return {
    ok: !!report?.ok,
    error: report?.error ?? null,
    trigger,
    dryRun,
    tries: call.tries,
    week: report?.week ?? null,
    shifted: report?.shifted ?? null,
    writtenCount: (report?.written ?? []).length,
    archived: report?.archived ?? 0,
    problems: problems.total,
    alerted: !!alert?.ok,
    alertTo: alert?.to ?? null,
    report,
  };
}

// What on this run needs a human, split by cause — the fixes are different. A
// report that never arrived is chased with PayMore; an incomplete week is
// waiting on the daily import; a parse problem is a code change.
function weeklyProblems(report: any) {
  const warnings = (report?.warnings ?? []) as any[];
  // Two warnings are routine bookkeeping rather than problems: a re-run finding
  // the block already written, and an explicit inPlace override.
  const realWarnings = warnings.filter((w) =>
    !/^block already labelled/.test(String(w?.note ?? "")) &&
    !/^inPlace/.test(String(w?.note ?? "")));

  const p = {
    notRun: report?.ok === false ? String(report?.error ?? "unknown error") : null,
    missingEmails: (report?.missingEmails ?? []) as any[],
    incomplete: (report?.incomplete ?? []) as any[],
    errors: (report?.errors ?? []) as any[],
    unfilled: (report?.skipped ?? []) as any[],
    warnings: realWarnings,
    total: 0,
  };
  p.total = (p.notRun ? 1 : 0) + p.missingEmails.length + p.incomplete.length
    + p.errors.length + p.unfilled.length + p.warnings.length;
  return p;
}

// ---------------------------------------------------------------------------
// Duplicated from sales-ingest on purpose: this is the retry that fixed the
// intermittent /exec 404s, where the 302 hop to script.googleusercontent.com
// serves a Google Docs error page instead of the function's JSON. Safe to retry
// because the import is idempotent, and "another import is already running" is
// retried too — that means a prior attempt is still finishing, and the backoff
// outlasts a normal run.
// ---------------------------------------------------------------------------
async function callAppsScript(target: URL, attempts = 3): Promise<{ report: any; tries: number }> {
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(target.toString(), { method: "POST", redirect: "follow" });
      const txt = await res.text();
      try {
        const parsed = JSON.parse(txt);
        if (/already running/i.test(String(parsed.error ?? ""))) {
          last = String(parsed.error);
        } else {
          return { report: parsed, tries: i };
        }
      } catch (_) {
        last = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
      }
    } catch (err) {
      last = `could not reach the Apps Script: ${String(err)}`;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, i * 4000));
  }
  return {
    report: {
      ok: false,
      error: `Apps Script did not return usable JSON after ${attempts} attempts. `
        + `If this persists, check the web app is deployed with access=Anyone. Last response — ${last}`,
    },
    tries: attempts,
  };
}

async function alertRecipients(sb: any): Promise<string[]> {
  const { data } = await sb.from("email_recipients").select("email").eq("list_key", ALERT_LIST_KEY);
  const list = (data ?? []).map((r: any) => r.email).filter(Boolean);
  return list.length ? list : ALERT_FALLBACK;
}

function wkBlock(title: string, blurb: string, lines: string[]) {
  if (!lines.length) return "";
  return `<div style="margin-top:18px;">
      <div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#1f9d57;font-weight:700;margin-bottom:6px;">${esc(title)}</div>
      <p style="margin:0 0 8px;color:#64707c;font-size:14px;line-height:1.5;">${esc(blurb)}</p>
      ${lines.slice(0, 12).map((l) =>
        `<div style="color:#1a1f24;font-size:14px;padding:5px 0;border-bottom:1px solid #eaefeb;">${l}</div>`).join("")}
      ${lines.length > 12 ? `<div style="color:#9aa6ad;font-size:12px;padding-top:6px;">…and ${lines.length - 12} more</div>` : ""}
    </div>`;
}

async function sendWeeklyAlert(sb: any, report: any, p: any) {
  const to = await alertRecipients(sb);
  const wk = report?.week
    ? `${fmtDate(report.week.start)}–${fmtDate(report.week.end)}`
    : "the latest week";

  const failBlock = p.notRun
    ? `<div style="margin-top:18px;padding:12px 14px;background:#fdf0f0;border-left:3px solid #c0392b;border-radius:6px;">
         <div style="font-weight:600;color:#1a1f24;margin-bottom:6px;">Nothing was written to the Summary tab</div>
         <div style="color:#64707c;font-size:13px;">${esc(p.notRun)}</div>
       </div>`
    : "";

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7faf8;padding:28px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eaefeb;border-radius:18px;overflow:hidden;">
      <div style="padding:20px 24px;border-bottom:1px solid #eaefeb;">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#1f9d57;font-weight:700;">Weekly Summary</div>
        <div style="font-size:17px;font-weight:700;color:#1a1f24;margin-top:3px;">${esc(wk)} needs a look</div>
      </div>
      <div style="padding:20px 24px;">
        ${failBlock}
        ${wkBlock("Reports that never arrived",
          "No PayMore weekly report for these stores, so their conversion, traffic, inventory and processed columns are empty.",
          p.missingEmails.map((m: any) => `<strong>${esc(m.store)}</strong>`))}
        ${wkBlock("Days the sheet is still missing",
          "The week could not be totalled because the daily import has not filled these days.",
          p.incomplete.map((i: any) =>
            `<strong>${esc(i.store)}</strong> ${esc(i.field)} — ${esc((i.missing_days ?? []).join(", "))}`))}
        ${wkBlock("Cells left empty",
          "These figures did not parse out of the report, so the cell was left alone rather than filled with a guess.",
          p.unfilled.map((s: any) => `${esc(s.field)} <span style="color:#9aa6ad;">${esc(s.cell)}</span> — ${esc(s.reason)}`))}
        ${wkBlock("Parse problems", "An email arrived but could not be read.",
          p.errors.map((e: any) => `${esc(e.store || e.subject || "?")} — ${esc(e.error)}`))}
        ${wkBlock("Worth checking", "Everything else the run flagged.",
          p.warnings.map((w: any) =>
            `${esc(w.store || w.cell || "")} ${esc(w.note || w.field || "")}${w.reason ? " — " + esc(w.reason) : ""}`))}
        <p style="margin:18px 0 0;color:#9aa6ad;font-size:12px;">
          Summary tab &middot; week runs Sunday to Saturday &middot; ${esc(report?.ranAt || "")}
        </p>
      </div>
    </div>
  </div>`;

  const subject = p.notRun
    ? `Weekly Summary FAILED — ${wk}`
    : `Weekly Summary — ${p.total} item${p.total === 1 ? "" : "s"} need attention`;

  try {
    const res = await fetch(GMAIL_RELAY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
    });
    return { ok: res.ok, status: res.status, to };
  } catch (err) {
    return { ok: false, error: String(err), to };
  }
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtDate(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${+m[2]}/${+m[3]}` : esc(iso);
}
