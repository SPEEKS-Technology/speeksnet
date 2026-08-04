// ============================================================================
// sales-ingest — drives the Shopify daily sales email import.
//
// Flow:  pg_cron  ->  this function  ->  Apps Script web app  ->  Sales Summary
//        sheet  ->  (existing) sync-buysell  ->  app_cache.buy_sell_hub  ->  hub
//        ->  Buying & Selling widget.
//
// This function owns orchestration only; the Gmail read, the parse and the cell
// writes all live in google-apps-scripts/sales-email-import.gs, because that runs
// as the Google account that receives the emails and therefore needs no OAuth.
//
// Responsibilities here:
//   1. call the Apps Script and get its report
//   2. persist the run to sales_ingest_runs (the only record of restatements,
//      which are applied to the sheet silently by design)
//   3. alert DM/CEO when a store/date is still missing after the retry pass
//   4. kick sync-buysell so the widget reflects the new numbers immediately
//      instead of waiting out the 10-minute poll
//   5. serve last-run status to the Command Center UI
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

// Machine auth (pg_cron only). Deliberately NOT present in speeks.js: this same
// secret guards weekly-report, which emails real store managers, and the Gmail
// relay. The browser gets the pin path below instead.
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

// The DM/CEO button re-checks the REAL role by pin, because hiding a control in
// the frontend is not a security boundary. Mirrors email-recipients exactly; the
// users table stores "CEO" / "District Manager". Keep this in sync with the
// frontend gating or you get the KPI-role-gate class of bug (silent 403s).
const ADMIN_ROLES = ["ceo", "district manager"];

// The sales-email-import Apps Script web app (/exec), verified working 2026-08-04.
// SALES_IMPORT_URL overrides it. NOTE: editing that Apps Script does not change
// what this URL serves — a new deployment VERSION must be published, the same
// drift trap edge functions have.
const APPS_SCRIPT_URL = Deno.env.get("SALES_IMPORT_URL")
  || "https://script.google.com/macros/s/AKfycbxTQkoWLmrfGYro3kfSc4GqN2cvGDbtKOaoh_3kgXMv76E2tfOmTf0M21PxOQ-EYNL3/exec";

// Same relay the weekly report sends through — Apps Script + GmailApp, no DNS.
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL")
  || "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

const ALERT_LIST_KEY = "sales_import_alert";
const ALERT_FALLBACK = ["ethan.kushnir@speekstechnology.com"];

const STORE_ORDER = ["OVL", "LEE", "WSP", "MPL", "BAL"];

type Report = {
  ok: boolean;
  error?: string;
  ranAt?: string;
  dryRun?: boolean;
  written?: any[];
  corrected?: any[];
  unchanged?: number;
  missing?: { store: string; date: string }[];
  unverified?: { store: string; date: string }[];
  skipped?: any[];
  errors?: any[];
};

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
    // for it — the alert exists for unattended cron runs nobody is watching.
    p.actor = String(user.name || "");
    p.trigger = "manual";
    p.alert = "0";
  }

  if ((p.action || "ingest") === "status") return json(await status(sb));
  return json(await ingest(sb, p));
});

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------
async function ingest(sb: any, p: Record<string, string>) {
  const trigger = ["cron", "retry", "manual"].includes(p.trigger) ? p.trigger : "cron";
  const dryRun = p.dryRun === "1";
  // The cron's first pass runs with alert=0: a store whose email is merely late
  // should not page anyone. The retry pass an hour later runs alert=1, so only a
  // genuine no-show produces an alert.
  const alerting = p.alert === "1" && !dryRun;

  if (!APPS_SCRIPT_URL) {
    return { ok: false, error: "SALES_IMPORT_URL is not set — deploy sales-email-import.gs as a web app first" };
  }

  let report: Report;
  try {
    const target = new URL(APPS_SCRIPT_URL);
    target.searchParams.set("secret", SECRET);
    target.searchParams.set("action", "ingest");
    if (p.reverify) target.searchParams.set("reverify", p.reverify);
    if (dryRun) target.searchParams.set("dryRun", "1");
    // Apps Script /exec answers a 302 to googleusercontent for the body; fetch
    // follows it by default, so read the final response as JSON.
    const res = await fetch(target.toString(), { method: "POST", redirect: "follow" });
    const txt = await res.text();
    try {
      report = JSON.parse(txt);
    } catch (_) {
      // An HTML body here almost always means the web app is not deployed with
      // access=Anyone and Google served a sign-in page instead.
      report = {
        ok: false,
        error: `Apps Script did not return JSON (HTTP ${res.status}). `
          + `Check the web app is deployed with access=Anyone. First 200 chars: ${txt.slice(0, 200)}`,
      };
    }
  } catch (err) {
    report = { ok: false, error: `could not reach the Apps Script: ${String(err)}` };
  }

  const written = report.written ?? [];
  const corrected = report.corrected ?? [];
  const missing = report.missing ?? [];
  // No email arrived but the sheet already has numbers — informational only, and
  // deliberately NOT alertable: there is no action for anyone to take.
  const unverified = report.unverified ?? [];
  const skipped = report.skipped ?? [];
  const errors = report.errors ?? [];

  // Persist before alerting/refreshing, so a failure in either still leaves a
  // record of what the import actually did.
  let runId: number | null = null;
  if (!dryRun) {
    const { data, error } = await sb.from("sales_ingest_runs").insert({
      ok: !!report.ok,
      trigger,
      actor: p.actor || null,
      filled_n: written.length,
      corrected_n: corrected.length,
      unchanged_n: report.unchanged ?? 0,
      missing_n: missing.length,
      written, corrected, missing, skipped, errors,
      raw: report,
    }).select("id").single();
    if (!error) runId = data?.id ?? null;
  }

  // Any cell actually changed => refresh the cache now rather than leaving the
  // widget up to 10 minutes stale.
  let refreshed = false;
  if (!dryRun && (written.length || corrected.length)) refreshed = await kickSyncBuysell();

  let alert: any = null;
  if (alerting && (missing.length || !report.ok || errors.length)) {
    alert = await sendAlert(sb, report, missing, errors);
    if (runId != null && alert?.ok) await sb.from("sales_ingest_runs").update({ alerted: true }).eq("id", runId);
  }

  // Ping the client so the Command Center's import line updates without a
  // reload — the broadcast-as-ping pattern used by the other tools.
  if (!dryRun) await broadcastChange("salesimport");

  return {
    ok: !!report.ok,
    error: report.error ?? null,
    runId,
    trigger,
    dryRun,
    refreshed,
    alerted: !!alert?.ok,
    summary: {
      filled: written.length,
      corrected: corrected.length,
      unchanged: report.unchanged ?? 0,
      missing: missing.length,
      unverified: unverified.length,
      skipped: skipped.length,
      errors: errors.length,
    },
    written, corrected, missing, unverified, skipped, errors,
  };
}

// ---------------------------------------------------------------------------
// status — what the Command Center line renders
// ---------------------------------------------------------------------------
async function status(sb: any) {
  const { data } = await sb.from("sales_ingest_runs")
    .select("id, ran_at, ok, trigger, filled_n, corrected_n, missing_n, missing, errors")
    .order("ran_at", { ascending: false })
    .limit(1);

  const last = data?.[0] ?? null;
  if (!last) return { ok: true, lastRun: null, state: "never" };

  // "attention" is the only state the DM needs to act on: those store/dates
  // still have to be keyed in by hand.
  const state = !last.ok ? "failed" : last.missing_n > 0 ? "attention" : "clean";
  return {
    ok: true,
    state,
    lastRun: {
      id: last.id,
      ranAt: last.ran_at,
      trigger: last.trigger,
      filled: last.filled_n,
      corrected: last.corrected_n,
      missing: last.missing_n,
      missingList: last.missing ?? [],
      errorCount: (last.errors ?? []).length,
    },
  };
}

// ---------------------------------------------------------------------------
// side effects
// ---------------------------------------------------------------------------
async function kickSyncBuysell(): Promise<boolean> {
  try {
    const base = Deno.env.get("SUPABASE_URL")!;
    const res = await fetch(`${base}/functions/v1/sync-buysell?secret=${encodeURIComponent(SECRET)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}` },
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function broadcastChange(tool: string) {
  try {
    const base = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${base}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort */ }
}

async function alertRecipients(sb: any): Promise<string[]> {
  const { data } = await sb.from("email_recipients").select("email").eq("list_key", ALERT_LIST_KEY);
  const list = (data ?? []).map((r: any) => r.email).filter(Boolean);
  return list.length ? list : ALERT_FALLBACK;
}

async function sendAlert(sb: any, report: Report, missing: any[], errors: any[]) {
  const to = await alertRecipients(sb);

  // Group by date so the email reads "8/3 — LEE, WSP" rather than a flat list.
  const byDate = new Map<string, string[]>();
  for (const m of missing) {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date)!.push(m.store);
  }
  const rows = [...byDate.entries()].sort().map(([date, stores]) => {
    const ordered = STORE_ORDER.filter(s => stores.includes(s));
    return `<tr>
      <td style="padding:8px 14px;border-bottom:1px solid #eaefeb;font-weight:600;color:#1a1f24;">${fmtDate(date)}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #eaefeb;color:#64707c;">${ordered.join(", ")}</td>
    </tr>`;
  }).join("");

  const errBlock = errors.length
    ? `<div style="margin-top:18px;padding:12px 14px;background:#fff8f0;border-left:3px solid #d98324;border-radius:6px;">
         <div style="font-weight:600;color:#1a1f24;margin-bottom:6px;">Parse problems</div>
         ${errors.slice(0, 8).map((e: any) =>
           `<div style="color:#64707c;font-size:13px;">${esc(e.store || "?")} — ${esc(e.error || "")}</div>`).join("")}
       </div>`
    : "";

  const failBlock = report.ok ? "" :
    `<div style="margin-top:18px;padding:12px 14px;background:#fdf0f0;border-left:3px solid #c0392b;border-radius:6px;">
       <div style="font-weight:600;color:#1a1f24;margin-bottom:6px;">The import did not run</div>
       <div style="color:#64707c;font-size:13px;">${esc(report.error || "unknown error")}</div>
     </div>`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7faf8;padding:28px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eaefeb;border-radius:18px;overflow:hidden;">
      <div style="padding:20px 24px;border-bottom:1px solid #eaefeb;">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#1f9d57;font-weight:700;">Sales Import</div>
        <div style="font-size:17px;font-weight:700;color:#1a1f24;margin-top:3px;">Some numbers need entering by hand</div>
      </div>
      <div style="padding:20px 24px;">
        ${failBlock}
        ${rows ? `<p style="margin:0 0 12px;color:#64707c;font-size:14px;line-height:1.5;">
            The Shopify email never arrived for these, so the Sales Summary sheet is still blank.
            Everything else imported normally.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>` : ""}
        ${errBlock}
        <p style="margin:18px 0 0;color:#9aa6ad;font-size:12px;">
          Checked the last 7 days &middot; ${esc(report.ranAt || "")}
        </p>
      </div>
    </div>
  </div>`;

  const subject = report.ok
    ? `Sales import — ${missing.length} entr${missing.length === 1 ? "y" : "ies"} need manual entry`
    : `Sales import FAILED`;

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

// ---------------------------------------------------------------------------
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtDate(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${+m[2]}/${+m[3]}` : esc(iso);
}
