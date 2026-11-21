import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildCredentialEmail, type CredRow } from "./email.ts";

// =============================================================================
// credential-expiry — Expiring Credentials email (2026-11-21, migration 0196)
// =============================================================================
// Ethan, after creating the Entra secret for the Alerts Hub (24-month life):
// he wanted a renewal reminder for it, and for every credential the site uses
// that can expire. The inventory and what was left out is in
// docs/credential-expiry.md; the rows live in public.credential_expiry.
//
// Daily at 7:50am Central (cron credential-expiry-750am):
//   1. refresh auto rows (eBay refresh-token expiry off ebay_stores),
//   2. work out each row's stage — 60 / 30 / 14 / 7 / 1 days left, or expired,
//   3. mail a row's notify_list when it ENTERS a new stage, and every day once
//      expired. Rows due on the same morning for the same list share one mail.
//
// Stage-entry, not "days_left == 30": a cron day lost to an outage delays a
// warning by a day instead of skipping it. alert_for pins the stage to the
// expiry date it was raised for, so renewing (a later date) starts over clean.
//
// Rows with no date are never alerted on by themselves — they're listed at the
// foot of any mail that does go, so the gap stays visible.
//
// SENT through the Gmail relay like every other Email Recipients report (not
// notify_queue — that is per-person toggles, not lists). Empty list falls back
// to Ethan, like the other System Alerts.
//
//   ?secret=…                    run (cron)
//   ?secret=…&dryRun=1           return what would be sent + the HTML; send nothing, save nothing
//   ?secret=…&to=a@b.com         send only to that address; stages are NOT saved
//   ?secret=…&test=1&to=a@b.com  a sample mail of every dated row, regardless of stage
//   GET ?secret=…&list=1         the rows, with days left (for checking)
// =============================================================================

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";
const DEFAULT_LIST = "credential_expiry";
const FALLBACK_TO = "ethan.kushnir@speekstechnology.com";
const STAGES = [60, 30, 14, 7, 1];

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}


// Calendar days in Central time, so "1 day left" means tomorrow on the wall clock.
function chicagoDay(d: Date) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function daysLeft(expires: string, today: string) {
  const a = Date.parse(today + "T12:00:00Z");
  const b = Date.parse(chicagoDay(new Date(expires)) + "T12:00:00Z");
  return Math.round((b - a) / 86400000);
}
// The tightest threshold the row has reached, or null if more than 60 days out.
function stageFor(left: number): string | null {
  if (left <= 0) return "expired";
  let s: number | null = null;
  for (const t of STAGES) if (left <= t) s = t;
  return s === null ? null : String(s);
}

async function relay(to: string, subject: string, html: string) {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 4000));
    try {
      // redirect:"manual" — a 302 is proof the relay ran; following it can 404
      // AFTER the mail went (memory: gmail-relay-404-still-sent).
      const res = await fetch(GMAIL_RELAY, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ secret: OPS_SECRET, to, subject, html }), redirect: "manual",
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.ok || (status >= 300 && status < 400)) return { ok: true, status };
    } catch (e) { return { ok: false, status: 0, error: String(e).slice(0, 120) }; }
  }
  return { ok: false, status };
}

async function recipients(listKey: string): Promise<string[]> {
  const { data } = await sb.from("email_recipients").select("email").eq("list_key", listKey);
  const list = (data || []).map((r: any) => String(r.email)).filter(Boolean);
  return list.length ? list : [FALLBACK_TO];
}

async function refreshAuto(rows: any[]) {
  const ebay = rows.filter((r) => String(r.auto_source || "").startsWith("ebay_stores:"));
  if (!ebay.length) return;
  const { data } = await sb.from("ebay_stores").select("store_code, refresh_token_expires_at");
  const by = new Map((data || []).map((s: any) => [s.store_code, s.refresh_token_expires_at]));
  for (const r of ebay) {
    const exp = by.get(String(r.auto_source).split(":")[1]);
    if (exp && exp !== r.expires_at && Date.parse(exp) !== Date.parse(r.expires_at || "")) {
      await sb.from("credential_expiry").update({ expires_at: exp, updated_at: new Date().toISOString() }).eq("key", r.key);
      r.expires_at = exp;
    }
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorized" }, 401);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const test = url.searchParams.get("test") === "1";
  const toOverride = (url.searchParams.get("to") || "").trim();
  if (test && !toOverride) return json({ error: "test=1 needs to=<address>" }, 400);

  const { data: rowsRaw, error } = await sb.from("credential_expiry").select("*").eq("active", true);
  if (error) return json({ error: error.message }, 500);
  const rows = rowsRaw || [];
  await refreshAuto(rows);

  const today = chicagoDay(new Date());
  for (const r of rows) {
    r._left = r.expires_at ? daysLeft(r.expires_at, today) : null;
    r._stage = r._left === null ? null : stageFor(r._left);
  }

  if (url.searchParams.get("list") === "1") {
    return json({ today, rows: rows.map((r: any) => ({
      key: r.key, name: r.name, expires_at: r.expires_at, days_left: r._left, stage: r._stage,
      alert_stage: r.alert_stage, last_alert_on: r.last_alert_on, notify_list: r.notify_list,
    })) });
  }

  const undated = rows.filter((r: any) => !r.expires_at);
  const isDue = (r: any) => {
    if (!r._stage) return false;
    if (r.last_alert_on === today) return false;                  // one mail a day at most
    if (r._stage === "expired") return true;                      // daily once expired
    const sameExpiry = r.alert_for && Date.parse(r.alert_for) === Date.parse(r.expires_at);
    return !(sameExpiry && r.alert_stage === r._stage);           // entered a new stage
  };
  const due = test ? rows.filter((r: any) => r.expires_at) : rows.filter(isDue);
  if (!due.length) return json({ today, sent: 0, note: "nothing due", undated: undated.map((r: any) => r.key) });

  // Group by list so each list gets one mail.
  const byList = new Map<string, any[]>();
  for (const r of due) {
    const k = r.notify_list || DEFAULT_LIST;
    (byList.get(k) || byList.set(k, []).get(k)!).push(r);
  }

  const out: any[] = [];
  for (const [listKey, items] of byList) {
    const to = toOverride || (await recipients(listKey)).join(",");
    const cred: CredRow[] = items.map((r) => ({
      key: r.key, name: r.name, what: r.what, used_by: r.used_by,
      renew_steps: r.renew_steps, expires_at: r.expires_at, left: r._left,
    }));
    const { subject, html } = buildCredentialEmail(cred, undated.map((r: any) => r.name), today, test);
    if (dryRun) { out.push({ listKey, to, subject, keys: items.map((r) => r.key), html }); continue; }
    const res = await relay(to, subject, html);
    out.push({ listKey, to, subject, keys: items.map((r) => r.key), ...res });
    // A redirected or test send doesn't count — the real list still needs telling.
    if (res.ok && !toOverride) {
      for (const r of items) {
        await sb.from("credential_expiry").update({
          alert_stage: r._stage, alert_for: r.expires_at, last_alert_on: today, updated_at: new Date().toISOString(),
        }).eq("key", r.key);
      }
    }
  }
  return json({ today, dryRun, sent: dryRun ? 0 : out.filter((o) => o.ok).length, mails: out });
});
