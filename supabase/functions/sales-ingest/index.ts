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
// The 7am cash email. Called from this run rather than by a cron of its own —
// see the cash block below for why.
const CASH_REPORT_URL = (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1/cash-report";

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

  const target = new URL(APPS_SCRIPT_URL);
  target.searchParams.set("secret", SECRET);
  target.searchParams.set("action", "ingest");
  if (p.reverify) target.searchParams.set("reverify", p.reverify);
  if (dryRun) target.searchParams.set("dryRun", "1");
  const call = await callAppsScript(target);
  const report: Report = call.report;

  const written = report.written ?? [];
  const corrected = report.corrected ?? [];
  const missing = report.missing ?? [];
  // No email arrived but the sheet already has numbers — informational only, and
  // deliberately NOT alertable: there is no action for anyone to take.
  const unverified = report.unverified ?? [];
  const skipped = report.skipped ?? [];
  const errors = report.errors ?? [];

  // The Apps Script runs the BUYING import in the same pass and hangs its report
  // off `buying`. Pulled out here so it can share the alert: one email covers
  // whichever feed fell short — sales, buying, or both.
  const buy: any = report.buying ?? null;
  const buyMissing = buy?.missing ?? [];
  const buyErrors  = buy?.errors ?? [];
  const buyBroke   = !!buy && buy.ok === false;

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

  // Fires if EITHER feed needs a human — sales gaps, buying gaps, or both. The
  // email renders only the sections that actually have something in them, so a
  // buying-only morning does not arrive looking like a sales problem.
  let alert: any = null;
  const worthAlerting = missing.length || !report.ok || errors.length
    || buyMissing.length || buyErrors.length || buyBroke;
  if (alerting && worthAlerting) {
    alert = await sendAlert(sb, report, missing, errors, { missing: buyMissing, errors: buyErrors, broke: buyBroke, error: buy?.error });
    if (runId != null && alert?.ok) await sb.from("sales_ingest_runs").update({ alerted: true }).eq("id", runId);
  }

  // ---- cash on hand -------------------------------------------------------
  // The Day End Report carries the closing count as well as buying and reviews.
  // It does NOT go to the sheet — it lands here, and the 7am email reads it.
  //
  // Wrapped whole: cash is a bonus rider on this run and must never be able to
  // fail the import that carries it. Same rule the Apps Script applies to
  // reviews, enforced again on this side because the failure modes differ (a
  // schema change, a dead relay) and neither is worth losing today's sales over.
  let cash: any = null;
  try {
    if (!dryRun) {
      const rows = ((report.buying && report.buying.cash) || []) as any[];
      const up = rows
        .filter((r) => r && r.store && r.date)
        .map((r) => ({
          day: r.date, store: String(r.store).toUpperCase(),
          drawer: r.drawer ?? null, safe: r.safe ?? null, total: r.total ?? null,
          source: "day_end_report", updated_at: new Date().toISOString(),
        }));

      let stored = 0;
      let storeError: string | null = null;
      if (up.length) {
        const { error } = await sb.from("store_cash").upsert(up, { onConflict: "day,store" });
        storeError = error ? error.message : null;
        stored = error ? 0 : up.length;
      }
      cash = { stored, error: storeError };

      // Mail it — chained off the import rather than given a cron of its own,
      // because a second job at 7:00 would race the run that produces the data.
      // cash-report is idempotent per day, so the 8am retry re-enters here and
      // correctly does nothing.
      //
      // CALLED UNCONDITIONALLY, and that is the point. This used to be gated on
      // having stored something, which quietly undid cash-report's own rule that
      // it sends even when no figures arrived: on the one morning nothing
      // reached us at all, the email that exists to say so would never have been
      // asked for. Silence is exactly what that morning must not produce. A
      // failed write is the same case — the email then reports what IS in the
      // table and says how many stores it covers, which is the visible signal.
      // cash-report decides the day and skips Sundays on its own.
      const u = new URL(CASH_REPORT_URL);
      u.searchParams.set("secret", SECRET);
      const res = await fetch(u.toString());
      cash.mailed = res.ok ? await res.json().catch(() => ({ ok: true })) : `HTTP ${res.status}`;
    }
  } catch (e) {
    cash = { error: String((e as Error)?.message || e) };
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
    // What the cash rider did, so a run that quietly stopped storing cash is
    // visible in the run record rather than only in its absence from the email.
    cash,
    summary: {
      filled: written.length,
      corrected: corrected.length,
      unchanged: report.unchanged ?? 0,
      missing: missing.length,
      unverified: unverified.length,
      skipped: skipped.length,
      errors: errors.length,
      // The Apps Script runs the BUYING import in the same pass and hangs its
      // report off `buying`. Surfaced here so the manual button can say what it
      // did — without this the buying half runs completely invisibly.
      buying: report.buying
        ? {
            ok: report.buying.ok !== false,
            error: report.buying.error ?? null,
            filled: (report.buying.written ?? []).length,
            corrected: (report.buying.corrected ?? []).length,
            unchanged: report.buying.unchanged ?? 0,
            missing: (report.buying.missing ?? []).length,
            errors: (report.buying.errors ?? []).length,
            daysThru: (report.buying.daysThru ?? []).filter((d: any) => !d.skipped).length,
          }
        : null,
    },
    written, corrected, missing, unverified, skipped, errors,
    buying: report.buying ?? null,
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

// Calls the Apps Script /exec, retrying when Google hands back something that
// isn't our JSON.
//
// Why this exists: 2 of the 14 runs before 2026-08-06 died on
// "Apps Script did not return JSON (HTTP 404)" with a Google Docs HTML page in
// the body. The web app was deployed correctly the whole time — /exec answers a
// 302 to script.googleusercontent.com and that hop intermittently serves an
// error page instead. Nothing about the request is wrong, so the same request a
// few seconds later succeeds. Both times the 8am retry pass covered it, which is
// precisely why nobody noticed.
//
// Retrying is safe because the import is idempotent: a value equal to what is
// already in the cell counts as `unchanged` and writes nothing. So it does not
// matter whether a lost response means the script never ran or ran and we missed
// the answer.
//
// "another import is already running" is retried too — that is the script's own
// LockService, and it means a previous attempt is still finishing. The backoff
// is longer than a typical run (~8s) so the last attempt lands after it clears.
async function callAppsScript(target: URL, attempts = 3): Promise<{ report: Report; tries: number }> {
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(target.toString(), { method: "POST", redirect: "follow" });
      const txt = await res.text();
      try {
        const parsed = JSON.parse(txt) as Report;
        if (/already running/i.test(String(parsed.error ?? ""))) {
          last = String(parsed.error);
        } else {
          return { report: parsed, tries: i };
        }
      } catch (_) {
        // An HTML body can also mean the web app is not deployed with
        // access=Anyone — but that fails every time, so it surfaces after the
        // last attempt with the body text intact.
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

// Group by date so a block reads "8/3 — LEE, WSP" rather than a flat list.
function missingRows(missing: any[]) {
  const byDate = new Map<string, string[]>();
  for (const m of missing) {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date)!.push(m.store);
  }
  return [...byDate.entries()].sort().map(([date, stores]) => {
    const ordered = STORE_ORDER.filter(s => stores.includes(s));
    return `<tr>
      <td style="padding:8px 14px;border-bottom:1px solid #eaefeb;font-weight:600;color:#1a1f24;">${fmtDate(date)}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #eaefeb;color:#64707c;">${ordered.join(", ")}</td>
    </tr>`;
  }).join("");
}

// One feed's block. Returns "" when that feed is clean, so an email about
// buying alone carries no sales heading and vice versa.
function feedBlock(title: string, blurb: string, missing: any[], errors: any[]) {
  if (!missing.length && !errors.length) return "";
  const rows = missingRows(missing);
  const errs = errors.length
    ? `<div style="margin-top:10px;padding:10px 12px;background:#fff8f0;border-left:3px solid #d98324;border-radius:6px;">
         <div style="font-weight:600;color:#1a1f24;margin-bottom:4px;font-size:13px;">Parse problems</div>
         ${errors.slice(0, 8).map((e: any) =>
           `<div style="color:#64707c;font-size:13px;">${esc(e.store || e.subject || "?")} — ${esc(e.error || "")}</div>`).join("")}
       </div>`
    : "";
  return `<div style="margin-top:18px;">
      <div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#1f9d57;font-weight:700;margin-bottom:6px;">${esc(title)}</div>
      ${rows ? `<p style="margin:0 0 10px;color:#64707c;font-size:14px;line-height:1.5;">${esc(blurb)}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>` : ""}
      ${errs}
    </div>`;
}

async function sendAlert(
  sb: any, report: Report, missing: any[], errors: any[],
  buying: { missing: any[]; errors: any[]; broke: boolean; error?: string } = { missing: [], errors: [], broke: false },
) {
  const to = await alertRecipients(sb);

  const salesBlock = feedBlock(
    "Selling", "The Shopify email never arrived for these, so the Sales tab is still blank.",
    missing, errors);
  const buyBlock = feedBlock(
    "Buying", "No PayMore Day End Report arrived for these, so the Buy tab is still blank.",
    buying.missing, buying.errors);

  const buyFailBlock = buying.broke
    ? `<div style="margin-top:18px;padding:12px 14px;background:#fdf0f0;border-left:3px solid #c0392b;border-radius:6px;">
         <div style="font-weight:600;color:#1a1f24;margin-bottom:6px;">The buying import did not run</div>
         <div style="color:#64707c;font-size:13px;">${esc(buying.error || "unknown error")}</div>
       </div>`
    : "";

  // Name the feeds actually affected, so the subject and heading are honest when
  // only one of the two fell short.
  const hit: string[] = [];
  if (missing.length || errors.length) hit.push("selling");
  if (buying.missing.length || buying.errors.length || buying.broke) hit.push("buying");
  const which = hit.length === 2 ? "Selling and buying" : hit.length === 1
    ? (hit[0] === "buying" ? "Buying" : "Selling") : "Daily import";

  const failBlock = report.ok ? "" :
    `<div style="margin-top:18px;padding:12px 14px;background:#fdf0f0;border-left:3px solid #c0392b;border-radius:6px;">
       <div style="font-weight:600;color:#1a1f24;margin-bottom:6px;">The import did not run</div>
       <div style="color:#64707c;font-size:13px;">${esc(report.error || "unknown error")}</div>
     </div>`;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7faf8;padding:28px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eaefeb;border-radius:18px;overflow:hidden;">
      <div style="padding:20px 24px;border-bottom:1px solid #eaefeb;">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#1f9d57;font-weight:700;">Daily Import</div>
        <div style="font-size:17px;font-weight:700;color:#1a1f24;margin-top:3px;">Some numbers need entering by hand</div>
      </div>
      <div style="padding:20px 24px;">
        ${failBlock}
        ${buyFailBlock}
        ${salesBlock}
        ${buyBlock}
        <p style="margin:18px 0 0;color:#9aa6ad;font-size:12px;">
          Selling re-checked month to date &middot; buying over the last 3 days &middot; ${esc(report.ranAt || "")}
        </p>
      </div>
    </div>
  </div>`;

  const totalMissing = missing.length + buying.missing.length;
  const subject = !report.ok
    ? `Daily import FAILED`
    : totalMissing
      ? `${which} — ${totalMissing} entr${totalMissing === 1 ? "y" : "ies"} need manual entry`
      : `${which} — import problem`;

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
