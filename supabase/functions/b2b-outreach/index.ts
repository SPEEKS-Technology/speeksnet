import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// B2B mini-CRM: everything B2B sends by email, plus the outreach schedule.
//
// Two mails:
//
//   * the daily outreach digest -- clients whose cadence ("every N days/weeks/
//     months from a set date") has come due. One recipient, the notify_email the
//     CEO sets in CRM Settings, deliberately: a reach-out reminder addressed to
//     everybody is a reminder nobody owns
//   * quote-ready -- fired by b2b-deals the moment pricing is submitted, so the
//     approver knows a quote is sitting waiting on them. This one goes to the
//     `b2b_quote_ready` list in email_recipients, because managers asked to be
//     told as well as the CEO, and falls back to notify_email while that list is
//     empty
//
// It deliberately does NOT email the clients themselves. The ask was for "alerts
// they can set up via email to reach out to clients", and a reminder is what a
// CRM actually provides -- but the deciding factor is the downside of guessing
// wrong. A wrong reminder is a wasted email to ourselves; a wrong client email
// is unsolicited mail to a real business from a no-reply reports address, with
// their reply going somewhere nobody reads. So the reminder lands with us and
// the client-facing note is one click away in the app, sent from the sender's
// own mailbox -- the same reasoning the quote flow already follows.
//
// Endpoints
//   GET  ?secret=...                run the daily sweep and send the digest
//        &dryRun=1                  build it and return it, send nothing
//        &to=someone@x.com          send the digest here instead
//   GET  ?due=1                     JSON: who is due / overdue / upcoming
//   GET  ?settings=1                JSON: CRM settings + unreviewed client count
//   POST { action: 'set_crm_settings', notify_email, enabled, overdue_only,
//                                      quote_ready_enabled, wipe_fee, user }
//   POST { action: 'set_schedule', client_id, active, start, every, unit, note }
//   POST { action: 'mark_reviewed', client_id }
//   POST { action: 'log_touch', client_id, detail, user }
//   POST { action: 'notify_quote_ready', deal_id, secret }   <- from b2b-deals
//
// Reads and writes b2b_clients' outreach_* columns, b2b_outreach_log and
// b2b_crm_settings; reads b2b_deal_list for the quote-ready figures.
// The sender is the same Gmail Apps Script relay the weekly report uses.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SECRET      = "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL")
  || "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";
const RESEND_URL  = "https://api.resend.com/emails";
const FROM        = Deno.env.get("RESEND_FROM") || "Speeks Reports <onboarding@resend.dev>";

// Palette lifted from the weekly report so the two emails look like the same
// system. Values, not variables: every colour has to be inline in email HTML.
const C = {
  sage: "#1f9d57", sageDeep: "#178048", tint: "#e8f7ee",
  charcoal: "#1a1c1e", app: "#f1f5f2", card: "#ffffff", soft: "#f7faf8",
  amber: "#c07f0c", flagBg: "#fefaf3", flagBorder: "#f0dcb6",
  line: "#eaefeb", line2: "#f4f8f5", muted: "#64707c", faint: "#9aa6ad",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class Invalid extends Error {}

function str(v: unknown, max: number, label: string, required = false): string | null {
  const s = String(v ?? "").trim();
  if (!s) {
    if (required) throw new Invalid(`${label} is required.`);
    return null;
  }
  if (s.length > max) throw new Invalid(`${label} is too long (max ${max} characters).`);
  return s;
}

function isoDate(v: unknown, label: string): string | null {
  const s = str(v, 10, label);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) {
    throw new Invalid(`${label} must be a real date.`);
  }
  return s;
}

// Business days are Chicago days. Using UTC would fire the sweep on the wrong
// calendar date for six hours every evening.
function chicagoToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

const longDate = (d: string | null) => d
  ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
  : "—";

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

const SETTINGS_COLS = "notify_email,enabled,overdue_only,quote_ready_enabled,wipe_fee";

// CRM settings: the CEO's single notification address + toggles. This REPLACES
// the old leadership list — reach-out reminders now go only where the CEO says.
// The same address receives quote-ready mail, by the CEO's own choice.
async function loadSettings(sb: any) {
  try {
    const { data } = await sb.from("b2b_crm_settings").select(SETTINGS_COLS).eq("id", 1).maybeSingle();
    return {
      notify_email: (data?.notify_email || "").trim() || null,
      enabled: data ? data.enabled !== false : true,
      overdue_only: !!data?.overdue_only,
      quote_ready_enabled: data ? data.quote_ready_enabled !== false : true,
      wipe_fee: Number(data?.wipe_fee ?? 8),
    };
  } catch (_) {
    return { notify_email: null, enabled: true, overdue_only: false, quote_ready_enabled: true, wipe_fee: 8 };
  }
}

// Who hears that a quote is ready. Managers asked to be told too, not just the
// CEO, so this reads the same email_recipients table the weekly reports and the
// recycle report use -- one place to manage every list, and an allowlist UI that
// already exists.
//
// Falls back to the single CRM Settings address when the list is empty, which is
// also what happens the moment before anyone has added themselves. Losing the
// notification entirely because a list was never populated would be a worse
// failure than sending it to one person.
async function quoteReadyTo(sb: any, fallback: string | null): Promise<string[]> {
  try {
    const { data } = await sb.from("email_recipients")
      .select("email").eq("list_key", "b2b_quote_ready").limit(200);
    const list = (data || []).map((r: any) => String(r.email || "").trim()).filter(Boolean);
    if (list.length) return [...new Set(list)];
  } catch (_) { /* fall through to the single address */ }
  return fallback ? [fallback] : [];
}

// "Every 2 weeks" / "Every 3 months" / "Every 10 days"
function cadenceLabel(every: number | null, unit: string | null): string {
  const n = Number(every) || 0;
  const u = unit || "month";
  if (n < 1) return "—";
  return `Every ${n} ${u}${n === 1 ? "" : "s"}`;
}

async function sendEmail(to: string[], subject: string, html: string) {
  if (GMAIL_RELAY) {
    const res = await fetch(GMAIL_RELAY, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
    });
    const txt = await res.text();
    return { ok: res.ok, status: res.status, body: txt.slice(0, 300) };
  }
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, status: 0, body: "No GMAIL_RELAY_URL or RESEND_API_KEY set" };
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: txt.slice(0, 300) };
}

const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Tables and inline styles throughout: Gmail strips <style> blocks and Outlook
// ignores flexbox and border-radius.
function digestHtml(rows: any[], today: string): string {
  const card = (r: any) => {
    const due  = r.outreach_next_due as string;
    const late = daysBetween(due, today);
    const when = late > 0 ? `${late} day${late === 1 ? "" : "s"} overdue`
               : late === 0 ? "Due today" : `In ${-late} day${-late === 1 ? "" : "s"}`;
    const tone = late > 0 ? C.amber : C.sageDeep;
    const spend = Number(r.lifetime_cost) || 0;
    const facts = [
      r.contact ? esc(r.contact) : null,
      r.contact_email ? esc(r.contact_email) : null,
      r.contact_phone ? esc(r.contact_phone) : null,
    ].filter(Boolean).join(" &nbsp;·&nbsp; ");
    const history = [
      `${Number(r.deal_count) || 0} deal${Number(r.deal_count) === 1 ? "" : "s"} all time`,
      spend ? `$${spend.toLocaleString("en-US")} lifetime` : null,
      r.last_deal_at ? `last deal ${longDate(String(r.last_deal_at).slice(0, 10))}` : null,
      r.outreach_last_touch_at
        ? `last contacted ${longDate(String(r.outreach_last_touch_at).slice(0, 10))}`
        : "never contacted on this schedule",
    ].filter(Boolean).join(" &nbsp;·&nbsp; ");

    return `
    <tr><td style="padding:0 0 10px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:${C.card};border:1px solid ${C.line};border-radius:12px;">
        <tr><td style="padding:14px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:15px;font-weight:800;color:${C.charcoal};">
              ${esc(r.company)}
              <span style="display:inline-block;margin-left:6px;padding:2px 7px;border-radius:6px;
                           background:${C.tint};color:${C.sageDeep};font-size:10px;font-weight:800;">${esc(r.acronym)}</span>
            </td>
            <td align="right" style="font-size:11.5px;font-weight:800;color:${tone};white-space:nowrap;">${when}</td>
          </tr></table>
          ${facts ? `<div style="margin-top:5px;font-size:12.5px;color:${C.muted};">${facts}</div>` : ""}
          <div style="margin-top:4px;font-size:11.5px;color:${C.faint};">${history}</div>
          ${r.outreach_note ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:9px;">
            <tr><td style="padding:8px 11px;background:${C.soft};border-left:3px solid ${C.sage};
                           font-size:12px;color:${C.charcoal};">${esc(r.outreach_note)}</td></tr>
          </table>` : ""}
          <div style="margin-top:8px;font-size:11px;color:${C.faint};">
            ${cadenceLabel(r.outreach_every, r.outreach_unit)} from ${longDate(r.outreach_start)} &nbsp;·&nbsp; due ${longDate(due)}
          </div>
        </td></tr>
      </table>
    </td></tr>`;
  };

  const overdue = rows.filter((r) => daysBetween(r.outreach_next_due, today) > 0);
  const dueNow  = rows.filter((r) => daysBetween(r.outreach_next_due, today) <= 0);
  const label = (t: string, n: number) => `
    <tr><td style="padding:14px 0 8px;font-size:10.5px;font-weight:800;letter-spacing:.09em;
                   text-transform:uppercase;color:${C.faint};">${t} · ${n}</td></tr>`;

  return `
<div style="margin:0;padding:0;background:${C.app};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};">
<tr><td align="center" style="padding:26px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0"
         style="width:600px;max-width:600px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td style="padding:0 0 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:${C.card};border:1px solid ${C.line};border-radius:18px;">
        <tr><td style="padding:20px 22px;border-bottom:1px solid ${C.line2};">
          <div style="font-size:10.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:${C.sage};">
            SPEEKS Technology · B2B
          </div>
          <div style="margin-top:3px;font-size:21px;font-weight:800;color:${C.charcoal};">Clients To Reach Out To</div>
          <div style="margin-top:3px;font-size:13px;color:${C.muted};">
            ${rows.length} client${rows.length === 1 ? " is" : "s are"} due a check-in as of ${longDate(today)}.
          </div>
        </td></tr>
        <tr><td style="padding:6px 22px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${overdue.length ? label("Overdue", overdue.length) + overdue.map(card).join("") : ""}
            ${dueNow.length ? label("Due now", dueNow.length) + dueNow.map(card).join("") : ""}
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
            <tr><td style="padding:11px 13px;background:${C.flagBg};border:1px solid ${C.flagBorder};
                           border-radius:10px;font-size:12px;color:${C.charcoal};">
              Draft the note from Operations → Business-to-Business → Clients. It opens in your own mailbox, so
              the reply comes back to you — and marking it done there moves the schedule on.
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:0 0 8px;font-size:11px;color:${C.faint};">
      Sent by SPEEKS Reports because these clients have an outreach cadence set.
    </td></tr>
  </table>
</td></tr></table></div>`;
}

const money = (n: unknown) =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// "A quote is waiting on you." Sent the moment pricing is submitted, because
// that is when it stops being the store's problem and becomes the approver's.
//
// Everything here is one read from b2b_deal_list -- the rollups it already
// computes are exactly the figures worth putting in the email, and taking them
// from the same place the screen does means the two can't tell different
// stories about the same deal.
async function sendQuoteReady(sb: any, dealId: string) {
  const settings = await loadSettings(sb);
  if (!settings.quote_ready_enabled) return jsonResponse({ success: true, sent: false, reason: "quote-ready email is switched off" });
  // The list first, the single CRM Settings address as the floor. Bailing on
  // notify_email alone would now be wrong: a populated list is a perfectly good
  // answer even with no fallback address set.
  const to = await quoteReadyTo(sb, settings.notify_email);
  if (!to.length) return jsonResponse({ success: true, sent: false, reason: "nobody is set to receive quote-ready email" });

  const { data: d } = await sb.from("b2b_deal_list")
    .select("id,ref,company,contact,contact_email,pickup_date,pricing_store,priced_by," +
            "line_count,total_units,total_value,total_offer,total_wipe_fee,net_offer")
    .eq("id", dealId).maybeSingle();
  if (!d) return jsonResponse({ success: false, error: "Deal not found." }, 404);

  const row = (k: string, v: string) => `
    <tr>
      <td style="padding:7px 0;font-size:12px;color:${C.muted};white-space:nowrap;">${k}</td>
      <td style="padding:7px 0 7px 18px;font-size:13px;font-weight:700;color:${C.charcoal};text-align:right;">${v}</td>
    </tr>`;

  const html = `
<div style="margin:0;padding:0;background:${C.app};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};">
<tr><td align="center" style="padding:26px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0"
         style="width:600px;max-width:600px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td style="padding:0 0 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:${C.card};border:1px solid ${C.line};border-radius:18px;">
        <tr><td style="padding:20px 22px;border-bottom:1px solid ${C.line2};">
          <div style="font-size:10.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:${C.sage};">
            SPEEKS Technology &middot; B2B
          </div>
          <div style="margin-top:3px;font-size:21px;font-weight:800;color:${C.charcoal};">A Quote Is Ready To Send</div>
          <div style="margin-top:3px;font-size:13px;color:${C.muted};">
            ${esc(d.company)} has been priced and is waiting on your approval.
          </div>
        </td></tr>
        <tr><td style="padding:16px 22px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${row("Reference", `<span style="font-family:Consolas,monospace;">${esc(d.ref)}</span>`)}
            ${row("Client", esc(d.company))}
            ${row("Picked up", longDate(d.pickup_date))}
            ${row("Priced at", esc(d.pricing_store || "—"))}
            ${row("Priced by", esc(d.priced_by || "—"))}
            ${row("Items", `${d.line_count} line${Number(d.line_count) === 1 ? "" : "s"} &middot; ${d.total_units} unit${Number(d.total_units) === 1 ? "" : "s"}`)}
            ${row("Resale value", money(d.total_value))}
            ${row("Offer", money(d.total_offer))}
            ${Number(d.total_wipe_fee) > 0 ? row("Certified data wipes", `&minus;${money(d.total_wipe_fee)}`) : ""}
          </table>
        </td></tr>
        <tr><td style="padding:4px 22px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="background:${C.tint};border:1px solid #cfeada;border-radius:10px;">
            <tr>
              <td style="padding:12px 14px;font-size:12.5px;font-weight:700;color:${C.sageDeep};">We would pay</td>
              <td style="padding:12px 14px;font-size:19px;font-weight:800;color:${C.sageDeep};text-align:right;">${money(d.net_offer)}</td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
            <tr><td style="padding:11px 13px;background:${C.flagBg};border:1px solid ${C.flagBorder};
                           border-radius:10px;font-size:12px;color:${C.charcoal};">
              Open <b>Operations &rarr; Business-to-Business</b> to review it. From there you can send it to the client
              from your own mailbox, or send it back to pricing with a note if something needs changing.
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:0 0 8px;font-size:11px;color:${C.faint};">
      Sent by SPEEKS Reports because a B2B quote reached the approval stage.
    </td></tr>
  </table>
</td></tr></table></div>`;

  const res = await sendEmail(to, `B2B Quote Ready: ${d.company} (${d.ref})`, html);
  return jsonResponse({ success: true, sent: res.ok, to, relay: res.status });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ------------------------------------------------------------------ writes
  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const action = body.action;

      // CEO-only in the UI: the notification email + toggles for all reach-out mail.
      if (action === "set_crm_settings") {
        const email = str(body.notify_email, 200, "Notification email");
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          throw new Invalid("That doesn't look like a valid email address.");
        }
        const fee = Number(body.wipe_fee);
        if (!Number.isFinite(fee) || fee < 0 || fee > 9999999) {
          throw new Invalid("The certified wipe charge has to be a number, and not a negative one.");
        }
        const { error } = await supabase.from("b2b_crm_settings").update({
          notify_email: email,
          enabled: body.enabled !== false,
          overdue_only: body.overdue_only === true,
          quote_ready_enabled: body.quote_ready_enabled !== false,
          wipe_fee: Math.round(fee * 100) / 100,
          updated_at: new Date().toISOString(),
          updated_by: str(body.user, 120, "User"),
        }).eq("id", 1);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        const { data } = await supabase.from("b2b_crm_settings")
          .select(SETTINGS_COLS).eq("id", 1).maybeSingle();
        return jsonResponse({ success: true, settings: data });
      }

      // Called by b2b-deals when a deal reaches the quote stage, not by a
      // browser -- hence the shared secret rather than a role check.
      if (action === "notify_quote_ready") {
        if (body.secret !== SECRET) return jsonResponse({ success: false, error: "Not authorized" }, 401);
        return await sendQuoteReady(supabase, str(body.deal_id, 64, "Deal", true)!);
      }

      const clientId = str(body.client_id, 64, "Client", true)!;

      if (action === "set_schedule") {
        const active = body.active === true;
        const start  = isoDate(body.start, "Start date");
        const unit   = str(body.unit, 8, "Unit") || "month";
        if (!["day", "week", "month"].includes(unit)) throw new Invalid("Cadence unit must be day, week or month.");
        const every = body.every === null || body.every === undefined || body.every === ""
          ? null : Math.trunc(Number(body.every));
        if (every !== null && (!Number.isFinite(every) || every < 1 || every > 365)) {
          throw new Invalid("The cadence interval must be between 1 and 365.");
        }
        if (active && (!start || !every)) {
          throw new Invalid("Turning outreach on needs both a start date and a cadence.");
        }
        const { error } = await supabase.from("b2b_clients").update({
          outreach_active: active,
          outreach_start: start,
          outreach_every: every,
          outreach_unit: every ? unit : null,
          outreach_months: (every && unit === "month") ? every : null,  // legacy column, no longer read
          outreach_note: str(body.note, 2000, "Note"),
          outreach_reviewed_at: new Date().toISOString(),               // configuring counts as reviewed
        }).eq("id", clientId);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);

        const { data: fresh } = await supabase.from("b2b_client_list")
          .select("outreach_active,outreach_start,outreach_every,outreach_unit,outreach_note,outreach_next_due,outreach_reviewed_at")
          .eq("id", clientId).maybeSingle();
        return jsonResponse({ success: true, client: fresh });
      }

      // Mark a client handled without (or before) a cadence — clears it from the
      // "New Clients" queue so the CEO can zero the badge for clients that don't
      // need reminders.
      if (action === "mark_reviewed") {
        const { error } = await supabase.from("b2b_clients")
          .update({ outreach_reviewed_at: new Date().toISOString() }).eq("id", clientId);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // Someone actually reached out. This is the clock that moves the schedule
      // on -- the reminder emails deliberately do not.
      if (action === "log_touch") {
        const { data: c } = await supabase.from("b2b_client_list")
          .select("id,outreach_next_due").eq("id", clientId).maybeSingle();
        if (!c) return jsonResponse({ success: false, error: "That client no longer exists." }, 404);

        const now = new Date().toISOString();
        const { error } = await supabase.from("b2b_clients")
          .update({ outreach_last_touch_at: now, outreach_reminded_for: null }).eq("id", clientId);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);

        await supabase.from("b2b_outreach_log").insert({
          client_id: clientId, kind: "touch", due_on: c.outreach_next_due,
          detail: str(body.detail, 1000, "Detail"), logged_by: str(body.user, 120, "User"),
        });

        const { data: fresh } = await supabase.from("b2b_client_list")
          .select("outreach_last_touch_at,outreach_next_due").eq("id", clientId).maybeSingle();
        return jsonResponse({ success: true, client: fresh });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      if (err instanceof Invalid) return jsonResponse({ success: false, error: err.message }, 400);
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ------------------------------------------------------------------- reads
  try {
    const url = new URL(req.url);
    const today = chicagoToday();

    // CRM settings + New-Clients badge count (clients never reviewed).
    if (url.searchParams.get("settings")) {
      const settings = await loadSettings(supabase);
      const { count } = await supabase.from("b2b_clients")
        .select("id", { count: "exact", head: true }).is("outreach_reviewed_at", null);
      return jsonResponse({ success: true, settings, new_count: count || 0 });
    }

    // The app's own read: everything with a cadence, so the panel can show due,
    // overdue and upcoming without a second call.
    if (url.searchParams.get("due")) {
      const { data, error } = await supabase.from("b2b_client_list")
        .select("id,company,acronym,contact,contact_email,contact_phone,deal_count,lifetime_cost," +
                "last_deal_at,outreach_active,outreach_start,outreach_every,outreach_unit,outreach_note," +
                "outreach_last_touch_at,outreach_next_due")
        .eq("outreach_active", true).limit(2000);
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      const rows = (data || [])
        .filter((r: any) => r.outreach_next_due)
        .sort((a: any, b: any) => String(a.outreach_next_due).localeCompare(String(b.outreach_next_due)));
      return jsonResponse({ success: true, today, data: rows });
    }

    // The daily sweep. Gated on the shared secret, same as every other cron'd
    // function here.
    if (url.searchParams.get("secret") !== SECRET) {
      return jsonResponse({ success: false, error: "Not authorized" }, 401);
    }
    const dryRun = url.searchParams.get("dryRun") === "1";
    const settings = await loadSettings(supabase);

    const { data, error } = await supabase.from("b2b_client_list")
      .select("id,company,acronym,contact,contact_email,contact_phone,deal_count,lifetime_cost," +
              "last_deal_at,outreach_active,outreach_start,outreach_every,outreach_unit,outreach_note," +
              "outreach_last_touch_at,outreach_reminded_for,outreach_next_due")
      .eq("outreach_active", true).limit(2000);
    if (error) return jsonResponse({ success: false, error: error.message }, 500);

    // Due, and not already reminded about THIS occurrence. Comparing against the
    // due date rather than "did we email today" is what makes the job idempotent:
    // it can run every morning, or twice, and still send once per occurrence.
    // overdue_only trims out clients that are merely due today (not yet late).
    const rows = (data || [])
      .filter((r: any) => r.outreach_next_due && r.outreach_next_due < (settings.overdue_only ? today : (today + "~")))
      .filter((r: any) => !r.outreach_reminded_for || r.outreach_reminded_for < r.outreach_next_due)
      .sort((a: any, b: any) => String(a.outreach_next_due).localeCompare(String(b.outreach_next_due)));

    if (!rows.length) return jsonResponse({ success: true, today, due: 0, sent: false });

    const html = digestHtml(rows, today);
    const subject = rows.length === 1
      ? `B2B Outreach: ${rows[0].company} Is Due A Check-In`
      : `B2B Outreach: ${rows.length} Clients Are Due A Check-In`;

    // Recipient: the CEO's address from CRM settings (a ?to= override wins for tests).
    const override = url.searchParams.get("to");
    const to = override ? [override] : (settings.notify_email ? [settings.notify_email] : []);

    if (dryRun) {
      return jsonResponse({
        success: true, today, due: rows.length, sent: false, subject, to,
        enabled: settings.enabled, overdue_only: settings.overdue_only,
        clients: rows.map((r: any) => ({ company: r.company, due: r.outreach_next_due })), html,
      });
    }
    // Nothing to do if the CEO has notifications off or hasn't set an address yet.
    if (!override && (!settings.enabled || !to.length)) {
      return jsonResponse({ success: true, today, due: rows.length, sent: false,
        reason: !settings.enabled ? "notifications disabled" : "no notification email set" });
    }

    const res = await sendEmail(to, subject, html);

    // Only mark reminded when the send actually landed, so a relay outage means
    // a retry tomorrow rather than an occurrence silently skipped.
    if (res.ok) {
      for (const r of rows) {
        await supabase.from("b2b_clients")
          .update({ outreach_reminded_for: r.outreach_next_due }).eq("id", r.id);
      }
    }
    // Logged either way -- a failed send is the thing you most want a record of.
    await supabase.from("b2b_outreach_log").insert(rows.map((r: any) => ({
      client_id: r.id, kind: "reminder", due_on: r.outreach_next_due,
      sent_to: to.join(","), ok: res.ok,
      detail: res.ok ? null : `status ${res.status}: ${res.body}`.slice(0, 1000),
      logged_by: "cron",
    })));

    return jsonResponse({ success: true, today, due: rows.length, sent: res.ok, to, relay: res.status });
  } catch (err: any) {
    if (err instanceof Invalid) return jsonResponse({ success: false, error: err.message }, 400);
    return jsonResponse({ success: false, error: err.message }, 500);
  }
});
