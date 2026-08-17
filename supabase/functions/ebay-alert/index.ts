import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// SPEEKS CONNECT — ERROR WATCH
//
// Runs every 15 minutes and mails ONLY when something is wrong. A healthy pass
// sends nothing: an alerter that mails "all clear" 96 times a day is an alerter
// nobody reads, and the whole point of this one is that a mail from it means
// something needs fixing today.
//
// Every check answers "is the integration failing", not "is the business doing
// well". eBay's own seller metrics (defect rate, late shipment) already live on
// the dashboard and move for reasons no code change can fix; they are not errors
// and are deliberately not in here.
//
// DEDUPE. Each problem gets a stable issue_key describing the PROBLEM, never the
// time it was noticed, so the same fault recognises itself on the next pass and
// is not re-sent. A problem still unfixed after RENAG_HOURS is raised once more,
// so nothing rots quietly. When it stops being detected its row is deleted, and
// if it ever comes back it reads as new — which it is.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const SECRET = Deno.env.get("SYNC_SECRET") || "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

const RECIPIENT_LIST = "connect_alerts";
const TO_DEFAULT = ["ethan.kushnir@speekstechnology.com"];

// Thresholds. Each is deliberately looser than the thing it watches, so a single
// slow run never pages anybody.
const RENAG_HOURS         = 24;  // an unfixed problem is raised again after this
const SWEEP_STALE_MIN     = 90;  // live sweep runs every 20 min per store
const CRON_STALE_MIN      = 30;  // order poll runs every 2 min per store
const LISTING_STUCK_MIN   = 60;  // pending longer than this is not "in flight"
const TRACKING_STUCK_MIN  = 60;  // tracking known but never pushed back to eBay
const TOKEN_WARN_DAYS     = 30;  // refresh token; access token renews itself

type Issue = {
  key: string; store: string | null; severity: "critical" | "warning";
  title: string; detail: string;
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const minsAgo = (t: string | null) => t ? Math.round((Date.now() - new Date(t).getTime()) / 60000) : null;
const short = (s: unknown, n = 180) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// WHOSE PROBLEM IS IT. A listing eBay rejects for a missing item specific, a bad
// category or a title it does not allow is a DATA problem: the store already sees
// it in SPEEKS Connect and fixes it themselves, and mailing about it buries the
// alerts that mean the tool is actually broken. What survives this filter is the
// class of failure a store can do nothing about -- the connection, the shared
// rate limit, and eBay itself being down.
//
// Deliberately matched on HTTP status and transport words rather than on eBay's
// errorId list: the id list changes without notice, and a new data-validation id
// failing OPEN here would put us straight back to mailing about item specifics.
// An unrecognised error is treated as the store's, which is the quiet failure --
// the loud one would be nagging about work already being done.
const SYSTEMIC = /HTTP *(401|403|429|5[0-9][0-9])|"statusCode" *: *(401|403|429|5[0-9][0-9])|unauthor|invalid_grant|invalid_token|token (has )?expired|expired token|refresh token|rate limit|call limit|quota|throttl|internal error|service unavailable|temporarily unavailable|timed out|time out|ECONNRESET|network error/i;

// ---------------------------------------------------------------------------
async function collect(sb: any): Promise<{ issues: Issue[]; counts: Record<string, number> }> {
  const out: Issue[] = [];
  const counts: Record<string, number> = {};
  const push = (i: Issue) => out.push(i);

  // THE FAILURE MODE THIS EXISTS TO PREVENT. Every read below used to discard
  // its error and carry on with undefined data, which for an alerter is the
  // worst possible behaviour: one malformed filter and it reports "all clear"
  // forever, indistinguishably from a healthy system. A read that fails is now
  // itself a critical alert, and the row counts are returned so a dry run can
  // show the watchdog is actually seeing data rather than an empty table.
  const read = async (name: string, qb: any): Promise<any[]> => {
    const { data, error } = await qb;
    if (error) {
      push({
        key: `watchdog_read:${name}`, store: null, severity: "critical",
        title: `Error watch cannot read ${name}`,
        detail: `${short(error.message)} — until this is fixed, problems in ${name} will go unreported.`,
      });
      counts[name] = -1;
      return [];
    }
    counts[name] = (data || []).length;
    return data || [];
  };

  // --- 1. listings that failed, errored, or never left pending ---------------
  // Only rows that could BE a problem. Pulling the whole table works today at a
  // few hundred rows and quietly stops working at a thousand.
  const listings = await read("ebay_listings", sb.from("ebay_listings")
    .select("store_code, sku, status, last_error, attempts, last_attempt_at, title")
    .or("status.eq.failed,status.eq.pending,last_error.not.is.null"));
  for (const l of listings) {
    const st = String(l.status || "");
    const systemic = SYSTEMIC.test(String(l.last_error || ""));
    if (st === "failed" && systemic) {
      push({
        key: `listing_blocked:${l.store_code}:${l.sku}`, store: l.store_code, severity: "critical",
        title: `eBay refused a listing — ${l.sku}`,
        detail: `Not a data problem, so the store cannot clear it: ${short(l.last_error)}`,
      });
    } else if (st === "pending") {
      const m = minsAgo(l.last_attempt_at);
      if (m !== null && m > LISTING_STUCK_MIN) {
        push({
          key: `listing_stuck:${l.store_code}:${l.sku}`, store: l.store_code, severity: "critical",
          title: `Listing stuck pending — ${l.sku}`,
          detail: `No progress for ${m} minutes${l.attempts ? ` after ${l.attempts} attempts` : ""}.`,
        });
      }
    }
  }

  // --- 2. orders: errors, tracking never pushed, and long-unshipped ----------
  // Tracking captured but not pushed is the worst of these: the customer has
  // been shipped, eBay has not been told, and the clock on a late-shipment
  // defect is running against a store that actually did its job.
  // Same reasoning as the listings read. The 90-day floor keeps this bounded as
  // orders accumulate; an error older than that is history, not an alert.
  const orderFloor = new Date(Date.now() - 90 * 86400000).toISOString();
  const orders = await read("ebay_orders", sb.from("ebay_orders")
    .select("store_code, ebay_order_id, shopify_order_name, status, last_error, tracking_number, tracking_pushed_at, sold_at, updated_at")
    .gte("sold_at", orderFloor)
    .or("last_error.not.is.null,status.eq.imported,and(tracking_number.not.is.null,tracking_pushed_at.is.null)"));
  for (const o of orders) {
    const label = o.shopify_order_name || o.ebay_order_id;
    if (o.last_error) {
      push({
        key: `order_error:${o.store_code}:${o.ebay_order_id}`, store: o.store_code, severity: "critical",
        title: `Order error — ${label}`, detail: short(o.last_error),
      });
    }
    if (o.tracking_number && !o.tracking_pushed_at) {
      const m = minsAgo(o.updated_at);
      if (m !== null && m > TRACKING_STUCK_MIN) {
        push({
          key: `tracking_unpushed:${o.store_code}:${o.ebay_order_id}`, store: o.store_code, severity: "critical",
          title: `Tracking not sent to eBay — ${label}`,
          detail: `Tracking ${o.tracking_number} has been on this order for ${m} minutes and eBay still has not been told.`,
        });
      }
    }
    // An order the store simply has not packed yet is store behaviour, not a
    // broken tool, so it is not alerted here. Tracking that EXISTS and was never
    // pushed stays above: that one is the tool failing on a store that did its job.
  }

  // --- 3. the sweeps: did they error, and are they still running at all ------
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const sweeps: Array<[string, string]> = [["ebay_live_runs", "live sweep"], ["ebay_catalog_runs", "catalog sweep"]];
  for (const [tbl, name] of sweeps) {
    const runs = await read(tbl, sb.from(tbl)
      .select("store_code, started_at, error").gte("started_at", since).not("error", "is", null));
    // Keyed per store+sweep, not per run: a sweep erroring every 20 minutes is
    // ONE broken thing, and should read as one line rather than eighteen.
    const seen = new Set<string>();
    for (const r of runs) {
      const k = `sweep_error:${tbl}:${r.store_code}`;
      if (seen.has(k)) continue;
      seen.add(k);
      push({
        key: k, store: r.store_code, severity: "critical",
        title: `${r.store_code} ${name} failing`, detail: short(r.error),
      });
    }
  }

  // Via a view, NOT a plain select on ebay_live. That table is one row per live
  // listing (~1,900 across five stores) and PostgREST caps a select at 1,000, so
  // reading it whole silently drops whichever stores fall past the cap. The first
  // dry run of this alerter duly reported that WSP and OVL had never listed
  // anything, while both had hundreds.
  const fresh = await read("ebay_live_freshness", sb.from("ebay_live_freshness").select("store_code, last_seen"));
  const freshest: Record<string, string> = {};
  for (const r of fresh) freshest[r.store_code] = r.last_seen;

  // --- 4. stores: config, tokens, and a sweep that has gone quiet ------------
  const stores = await read("ebay_stores", sb.from("ebay_stores")
    .select("store_code, merchant_location_key, payment_policy_id, return_policy_id, fulfillment_policy_id, refresh_token_expires_at"));
  for (const s of stores) {
    const missing = [
      !s.merchant_location_key ? "location" : null,
      !s.payment_policy_id ? "payment policy" : null,
      !s.return_policy_id ? "return policy" : null,
      !s.fulfillment_policy_id ? "shipping policy" : null,
    ].filter(Boolean);
    if (missing.length) {
      push({
        key: `store_config:${s.store_code}`, store: s.store_code, severity: "critical",
        title: `${s.store_code} cannot publish`, detail: `Not set up: ${missing.join(", ")}.`,
      });
    }
    if (s.refresh_token_expires_at) {
      const days = (new Date(s.refresh_token_expires_at).getTime() - Date.now()) / 86400000;
      if (days < TOKEN_WARN_DAYS) {
        push({
          key: `token_expiring:${s.store_code}`, store: s.store_code,
          severity: days < 7 ? "critical" : "warning",
          title: `${s.store_code} eBay connection expires in ${Math.floor(days)} days`,
          detail: `Reconnect the store from SPEEKS Connect before it lapses; every listing and order stops when it does.`,
        });
      }
    }
    const m = minsAgo(freshest[s.store_code] || null);
    if (m === null) {
      push({
        key: `sweep_never:${s.store_code}`, store: s.store_code, severity: "warning",
        title: `${s.store_code} has never reported live listings`,
        detail: `No rows in ebay_live for this store.`,
      });
    } else if (m > SWEEP_STALE_MIN) {
      push({
        key: `sweep_stale:${s.store_code}`, store: s.store_code, severity: "critical",
        title: `${s.store_code} live sweep has stopped`,
        detail: `Last successful sweep was ${m} minutes ago; it should run every 20.`,
      });
    }
  }

  // --- 5. the same SKU live twice -------------------------------------------
  // One physical unit, two buyable listings. Whoever loses the race gets
  // cancelled, and the cancellation is a defect against the store.
  // Grouped in the database for the same reason as the freshness view, and here
  // the row cap would be actively dangerous: truncation turns the most important
  // check in this file into a silent false negative that gets worse as the
  // catalogue grows. The view returns a handful of rows or none.
  const dups = await read("ebay_live_duplicates", sb.from("ebay_live_duplicates")
    .select("store_code, sku, item_id_count, item_ids"));
  for (const d of dups) {
    push({
      key: `dup_live:${d.store_code}:${d.sku}`, store: d.store_code, severity: "critical",
      title: `Same SKU live twice — ${d.sku}`,
      detail: `eBay items ${d.item_ids} are both live for one unit. End all but one.`,
    });
  }

  // --- 6. have the cron jobs themselves stopped? ----------------------------
  // Everything above measures what the jobs PRODUCED. This measures the jobs.
  // A poll that stops finding orders looks identical to a poll that stopped
  // running, and only one of those is an emergency.
  const crons = await read("ebay_cron_health", sb.from("ebay_cron_health").select("jobname, last_run, failures_1h"));
  for (const c of crons) {
    const m = minsAgo(c.last_run);
    if (m === null || m > CRON_STALE_MIN) {
      push({
        key: `cron_stale:${c.jobname}`, store: null, severity: "critical",
        title: `Scheduled job stopped — ${c.jobname}`,
        detail: m === null ? "It has no recorded run at all." : `Last ran ${m} minutes ago.`,
      });
    } else if (Number(c.failures_1h) > 0) {
      push({
        key: `cron_failing:${c.jobname}`, store: null, severity: "critical",
        title: `Scheduled job failing — ${c.jobname}`,
        detail: `${c.failures_1h} failed run(s) in the last hour.`,
      });
    }
  }

  return { issues: out, counts };
}

// ---------------------------------------------------------------------------
const C = {
  sage: "#1f9d57", charcoal: "#1a1c1e", app: "#f1f5f2", card: "#ffffff",
  line: "#eaefeb", muted: "#64707c", faint: "#9aa6ad", red: "#b23636",
  redBg: "#fcecec", redRing: "#f6d5d5",
  amberBg: "#fdf3e1", amberRing: "#f0dcb6", amberInk: "#8a5a06",
};

function build(issues: Issue[], firstSeen: Record<string, string>) {
  const crit = issues.filter((i) => i.severity === "critical");
  const warn = issues.filter((i) => i.severity === "warning");

  const card = (i: Issue) => {
    const bad = i.severity === "critical";
    const since = firstSeen[i.key];
    const age = since ? Math.round((Date.now() - new Date(since).getTime()) / 60000) : 0;
    const ageTxt = age >= 1440 ? `${Math.floor(age / 1440)}d` : age >= 60 ? `${Math.floor(age / 60)}h` : `${age}m`;
    return `<tr><td style="padding:0 0 10px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="background:${bad ? C.redBg : C.amberBg};border:1px solid ${bad ? C.redRing : C.amberRing};border-radius:12px;">
        <tr><td style="padding:12px 14px;">
          <div style="font-size:13.5px;font-weight:800;color:${bad ? C.red : C.amberInk};">
            ${i.store ? `<span style="display:inline-block;background:#ffffff;border:1px solid ${bad ? C.redRing : C.amberRing};border-radius:5px;padding:1px 6px;font-size:10.5px;margin-right:7px;">${esc(i.store)}</span>` : ""}${esc(i.title)}
          </div>
          <div style="font-size:12.5px;line-height:1.5;color:${C.muted};margin-top:4px;">${esc(i.detail)}</div>
          ${age > 0 ? `<div style="font-size:10.5px;color:${C.faint};margin-top:5px;">Open for ${ageTxt}</div>` : ""}
        </td></tr>
      </table></td></tr>`;
  };

  const section = (label: string, list: Issue[]) => !list.length ? "" :
    `<div style="margin:18px 2px 10px;border-left:2px solid ${C.sage};padding-left:11px;
       font-size:14.5px;font-weight:800;color:${C.charcoal};">${label} (${list.length})</div>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.map(card).join("")}</table>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:18px 22px;">
    <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology</div>
    <div style="font-size:19px;font-weight:800;color:#ffffff;margin-top:2px;">SPEEKS Connect — Errors</div>
    <div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">
      ${crit.length} Needing Attention${warn.length ? `, ${warn.length} To Watch` : ""}</div>
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:14px 20px 20px;">
    ${section("Fix Now", crit)}
    ${section("Worth A Look", warn)}
  </td></tr>
  <tr><td style="padding:14px;text-align:center;color:${C.faint};font-size:10.5px;line-height:1.6;border-top:1px solid ${C.line};background:#f7faf8;">
    Checked every 15 minutes. You only get this mail when something is wrong, and
    each problem is reported once until it is fixed.
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function loadRecipients(sb: any): Promise<string[]> {
  const { data, error } = await sb.from("email_recipients").select("email").eq("list_key", RECIPIENT_LIST);
  if (error) return TO_DEFAULT;
  const list = (data || []).map((r: any) => String(r.email)).filter(Boolean);
  return list.length ? list : TO_DEFAULT;
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  if (q("secret") !== SECRET) return json({ error: "Unauthorized" }, 401);

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { issues, counts } = await collect(sb);
    const now = new Date().toISOString();

    const { data: prior } = await sb.from("ebay_alert_state").select("*");
    const priorBy: Record<string, any> = {};
    for (const r of (prior || [])) priorBy[r.issue_key] = r;

    // Alert on anything never alerted, or still open past the re-nag window.
    const renagBefore = new Date(Date.now() - RENAG_HOURS * 3600_000).toISOString();
    const toAlert = issues.filter((i) => {
      const p = priorBy[i.key];
      return !p || !p.last_alerted || p.last_alerted < renagBefore;
    });

    const firstSeen: Record<string, string> = {};
    for (const i of issues) firstSeen[i.key] = priorBy[i.key]?.first_seen || now;

    const html = toAlert.length ? build(toAlert, firstSeen) : "";
    if (q("dryRun") === "1") {
      return (q("html") === "1" && html)
        ? new Response(html, { headers: { "Content-Type": "text/html" } })
        : json({
            ok: true, open: issues.length, wouldAlert: toAlert.length,
            // rowsRead proves the watchdog is reading real data. All zeroes on a
            // busy system means the checks are blind, which looks identical to
            // "nothing is wrong" in the issue list alone. -1 means that read failed.
            rowsRead: counts,
            issues: issues.map((i) => ({ severity: i.severity, store: i.store, title: i.title, key: i.key })),
          });
    }

    let sent: any = null;
    if (toAlert.length) {
      const to = q("to") ? [q("to")!] : await loadRecipients(sb);
      const nCrit = toAlert.filter((i) => i.severity === "critical").length;
      const subject = `SPEEKS Connect — ${toAlert.length} issue${toAlert.length === 1 ? "" : "s"}` +
        (nCrit ? ` (${nCrit} to fix now)` : "");
      const res = await fetch(GMAIL_RELAY, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
      });
      sent = { ok: res.ok, status: res.status, to };
    }

    // Record what is open now. Anything not in this pass has been fixed, so its
    // row goes: if it ever returns it should read as new, because it is.
    for (const i of issues) {
      const p = priorBy[i.key];
      const alerted = toAlert.some((t) => t.key === i.key);
      await sb.from("ebay_alert_state").upsert({
        issue_key: i.key, store_code: i.store, severity: i.severity, summary: i.title,
        first_seen: p?.first_seen || now,
        last_seen: now,
        last_alerted: alerted ? now : (p?.last_alerted ?? null),
        times_alerted: (p?.times_alerted || 0) + (alerted ? 1 : 0),
      }, { onConflict: "issue_key" });
    }
    const openKeys = new Set(issues.map((i) => i.key));
    const goneKeys = (prior || []).map((r: any) => r.issue_key).filter((k: string) => !openKeys.has(k));
    if (goneKeys.length) await sb.from("ebay_alert_state").delete().in("issue_key", goneKeys);

    return json({ ok: true, open: issues.length, alerted: toAlert.length, resolved: goneKeys.length, sent });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? "").slice(0, 400) }, 500);
  }
});
