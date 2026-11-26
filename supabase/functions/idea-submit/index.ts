import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// IDEA SUBMIT — the header lightbulb's popup posts here. Since 2026-11-19 that
// popup is "Submit a Ticket" (dev tracker Phase 3, D3): what a store sends
// becomes a ticket in the Development tracker's TRIAGE, and the email to the
// `idea_submissions` list still goes out, now with the ticket's number and a
// link to it. Plan: docs/plans/dev-tracker-HANDOFF.md.
// ----------------------------------------------------------------------------
//   GET   + x-user-pin           the form's lists (types the form may use,
//                                areas) and "My Tickets": the tickets this
//                                person submitted, with their status
//   POST  + x-user-pin           multipart: Type, Area, Description,
//                                Attachment (optional) → a ticket in Triage
//   POST  without a PIN          the OLD form (Name, Category, Tool,
//                                Idea_Description, Attachment) → email only
//
// WHY THE OLD PATH STAYS: this function is live and speeksnet.com's current
// front end posts the old form, with no PIN, until the dev tracker branch
// ships. Deploying the new behaviour must not break the form the stores have
// today. Once the release is out, nothing sends a PIN-less post except a
// session that never had a PIN (scripts/test-login.html), and email-only is a
// fine answer for that.
//
// WHO: anyone signed in with a real PIN may submit. The reporter is resolved
// from the PIN (users.id + name), never from the body — the Projects pattern
// (CLAUDE.md, "Identity"). A TEST ACCOUNT (0160) gets the lists and an empty
// My Tickets, and is refused on submit: a demo shouldn't put tickets in front
// of the devs.
//
// TITLE: the store form has no title box (D3: type, area, description,
// attachment — short on purpose). The title is the description's first line,
// cut at a word near 80 characters; a dev retitles it in triage if needed.
//
// "Submitted" means the TICKET exists. The email is best-effort after that: a
// relay failure comes back as {emailed:false}, never as an error, because the
// person would resubmit and the devs would get the ticket twice.
//
// The file goes to the private `idea-attachments` bucket (0173). Its PATH is
// stored on the ticket (0191) — dev-tickets signs a fresh link per read — and
// the email carries a year-long signed link, since it is read from an inbox.
// ============================================================================

const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";
const LIST_KEY = "idea_submissions";
// The address the form was hardcoded to before the list existed — an empty or
// unreadable list sends the idea to the person it has always gone to.
const FALLBACK_TO = ["ethan.kushnir@speekstechnology.com"];
const BUCKET = "idea-attachments";
const MAX_FILE = 10 * 1024 * 1024; // matches the bucket limit
// A year: the link is read from an inbox, possibly long after, and the bucket
// is private, so the signature is the only way in.
const LINK_TTL = 60 * 60 * 24 * 365;
const SITE = "https://speeksnet.com";
// The old form's categories (the PIN-less path only).
const CATEGORIES = ["New Feature", "Tool Based", "Process Improvement", "Bug Fix / Issue", "Other"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

type Sb = ReturnType<typeof createClient>;
type FileRef = { path: string; name: string; size: number; type: string; url: string };

// The description's first line, cut at a word boundary near 80 characters.
function titleFrom(desc: string): string {
  const first = (desc.split("\n").map((l) => l.trim()).find(Boolean) || "").replace(/\s+/g, " ");
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  const sp = cut.lastIndexOf(" ");
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, "") + "…";
}

async function storeFile(sb: Sb, att: File, folder: string): Promise<FileRef | string> {
  if (att.size > MAX_FILE) return "That file is over 10 MB — please attach a smaller one.";
  const safe = att.name.replace(/[^\w.\-]+/g, "_").slice(-80) || "attachment";
  const path = `${folder}${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safe}`;
  const up = await sb.storage.from(BUCKET).upload(path, att, { contentType: att.type || undefined });
  if (up.error) return `Attachment upload failed: ${up.error.message}`;
  const signed = await sb.storage.from(BUCKET).createSignedUrl(path, LINK_TTL);
  if (signed.error || !signed.data?.signedUrl) return "Attachment saved but its link could not be made.";
  return { path, name: att.name || safe, size: att.size, type: att.type || "", url: signed.data.signedUrl };
}

async function recipients(sb: Sb): Promise<string[]> {
  const { data } = await sb.from("email_recipients").select("email").eq("list_key", LIST_KEY);
  const listed = (data || []).map((r: any) => String(r.email || "").trim()).filter(Boolean);
  return listed.length ? listed : FALLBACK_TO;
}

// redirect: 'manual' — the relay answers with a 302 to an echo URL that can
// 404 AFTER the mail went. A 3xx is a send; following it would report a
// delivered mail as failed.
async function sendMail(to: string[], subject: string, html: string) {
  const res = await fetch(GMAIL_RELAY, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
  });
  if (!(res.status >= 300 && res.status < 400) && !res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`relay ${res.status}: ${t.slice(0, 160)}`);
  }
}

// 2026-11-25: the footer cell's square background painted over the card's
// rounded bottom corners (Outlook showed the border cut off), so the footer
// carries its own 11px bottom radius (12px card minus the 1px border).
function emailShell(eyebrow: string, heading: string, rows: [string, string][], desc: string,
  file: { name: string; url: string } | null, cta: { href: string; label: string } | null, footer: string): string {
  const row = ([k, v]: [string, string]) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#64707c;font-size:13px;white-space:nowrap;vertical-align:top;">${k}</td>` +
    `<td style="padding:6px 0;color:#1a1c1e;font-size:14px;font-weight:600;">${v}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f1f5f2;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f2;padding:24px 12px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #eaefeb;border-radius:12px;border-collapse:separate;overflow:hidden;">
  <tr><td style="padding:20px 24px 8px;"><div style="font-size:12px;color:#1f9d57;font-weight:700;letter-spacing:.04em;">${eyebrow}</div>
    <div style="font-size:20px;color:#1a1c1e;font-weight:800;margin-top:4px;">${heading}</div></td></tr>
  <tr><td style="padding:8px 24px;"><table cellpadding="0" cellspacing="0">${rows.map(row).join("")}</table></td></tr>
  <tr><td style="padding:8px 24px 16px;"><div style="background:#f7faf8;border:1px solid #eaefeb;border-radius:8px;padding:14px 16px;color:#1a1c1e;font-size:14px;line-height:1.5;white-space:pre-wrap;">${esc(desc)}</div></td></tr>
  ${file ? `<tr><td style="padding:0 24px 16px;font-size:13px;color:#64707c;">Attachment: <a href="${esc(file.url)}" style="color:#1f9d57;font-weight:700;">${esc(file.name)}</a></td></tr>` : ""}
  ${cta ? `<tr><td style="padding:0 24px 22px;"><a href="${esc(cta.href)}" style="display:inline-block;background:#1f9d57;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;border-radius:8px;">${esc(cta.label)}</a></td></tr>` : ""}
  <tr><td style="padding:14px;text-align:center;color:#9aa6ad;font-size:10.5px;border-top:1px solid #eaefeb;background:#f7faf8;border-radius:0 0 11px 11px;">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const whenNow = () =>
  new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

// Realtime ping so an open Development page shows the new ticket in Triage.
// No row data travels over realtime. Best-effort.
async function broadcastChange() {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: "speeks-notify", event: "changed", payload: { tool: "dev-tickets", store: null, ts: Date.now() } }] }),
    });
  } catch (_) { /* best-effort */ }
}

// Who the PIN belongs to: a real person, a test account, or nobody.
async function whoIs(sb: Sb, pin: string) {
  const { data: u } = await sb.from("users").select("id, name, role, store").eq("pin", pin).maybeSingle();
  if (u) return { id: String(u.id), name: String(u.name || "").trim(), role: String(u.role || ""), store: String(u.store || ""), test: false };
  const { data: t } = await sb.from("test_users").select("name, role, store").eq("pin", pin).maybeSingle();
  if (t) return { id: null, name: String(t.name || "").trim(), role: String(t.role || ""), store: String(t.store || ""), test: true };
  return null;
}

// The form's lists. dev_only types are for devs creating tickets on the
// Development page, not for this form (0188).
async function formLists(sb: Sb) {
  const [ty, ar] = await Promise.all([
    sb.from("dev_ticket_types").select("key, label, sort").eq("active", true).eq("dev_only", false).order("sort"),
    sb.from("dev_ticket_areas").select("key, label, sort").eq("active", true).order("sort"),
  ]);
  return { types: ty.data || [], areas: ar.data || [], error: ty.error || ar.error };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const pin = req.headers.get("x-user-pin") || "";

  // ---- GET: the form's lists + My Tickets ----
  if (req.method === "GET") {
    if (!pin) return json({ success: false, error: "Sign in again — your session has no PIN." }, 401);
    const who = await whoIs(sb, pin);
    if (!who) return json({ success: false, error: "That PIN isn't recognised." }, 401);
    const lists = await formLists(sb);
    if (lists.error) return json({ success: false, error: lists.error.message }, 500);
    let mine: any[] = [];
    if (who.id) {
      // Only what they sent through this form. A dev's own tickets (and the
      // GitHub import credited to them) are on the Development page.
      const { data: t, error } = await sb.from("dev_tickets")
        .select("id, title, type, area, status, created_at, updated_at, closed_at")
        .eq("reporter_id", who.id).eq("source", "idea")
        .order("id", { ascending: false }).limit(100);
      if (error) return json({ success: false, error: error.message }, 500);
      mine = t || [];
      // Why it won't be done is the one note the submitter is owed (the
      // dev-tickets function makes it required for exactly this reason).
      const closed = mine.filter((x) => x.status === "wont_do").map((x) => x.id);
      if (closed.length) {
        const { data: ev } = await sb.from("dev_ticket_events")
          .select("ticket_id, note, created_at").eq("kind", "status").eq("to_value", "wont_do")
          .in("ticket_id", closed).order("created_at", { ascending: true });
        const why = new Map((ev || []).map((e: any) => [Number(e.ticket_id), e.note]));
        mine = mine.map((x) => x.status === "wont_do" ? { ...x, reason: why.get(Number(x.id)) || null } : x);
      }
    }
    return json({ success: true, me: { name: who.name, test: who.test }, types: lists.types, areas: lists.areas, tickets: mine });
  }

  if (req.method !== "POST") return json({ success: false, error: "GET or POST only" }, 405);

  let form: FormData;
  try { form = await req.formData(); }
  catch { return json({ success: false, error: "Could not read the form." }, 400); }
  const att = form.get("Attachment");
  const hasFile = att && att instanceof File && att.size > 0;

  // ---- POST with a PIN: a ticket in Triage ----
  if (pin) {
    const who = await whoIs(sb, pin);
    if (!who) return json({ success: false, error: "That PIN isn't recognised — sign out and back in." }, 401);
    if (who.test || !who.id) return json({ success: false, error: "Test accounts can't submit tickets." }, 403);

    const desc = String(form.get("Description") || "").replace(/\r\n/g, "\n").trim().slice(0, 20000);
    if (!desc) return json({ success: false, error: "Describe what you'd like changed." }, 400);
    const lists = await formLists(sb);
    const type = String(form.get("Type") || "");
    if (!lists.types.some((t: any) => t.key === type)) return json({ success: false, error: "Pick what kind of ticket this is." }, 400);
    const areaRaw = String(form.get("Area") || "");
    const area = areaRaw ? (lists.areas.some((a: any) => a.key === areaRaw) ? areaRaw : undefined) : null;
    if (area === undefined) return json({ success: false, error: "That area isn't on the list — pick another." }, 400);

    // File first: a file that fails to store should stop the submit, not
    // arrive as a ticket that says "see attached" with nothing attached.
    let file: FileRef | null = null;
    if (hasFile) {
      const r = await storeFile(sb, att as File, "tickets/");
      if (typeof r === "string") return json({ success: false, error: r }, r.includes("10 MB") ? 400 : 500);
      file = r;
    }

    const { data: row, error } = await sb.from("dev_tickets").insert({
      title: titleFrom(desc) || "Untitled", description: desc, type, area, priority: "normal", status: "triage",
      reporter_id: who.id, reporter_name: who.name, reporter_store: who.store || null,
      source: "idea",
      attachments: file ? [{ path: file.path, name: file.name, size: file.size, type: file.type }] : [],
    }).select("id, title, status").single();
    if (error) return json({ success: false, error: `The ticket wasn't saved: ${error.message}` }, 500);
    await sb.from("dev_ticket_events").insert({
      ticket_id: row.id, kind: "created", actor_name: who.name, actor_id: who.id,
      to_value: "triage", note: "Sent from Submit a Ticket",
    });
    await broadcastChange();

    const typeLabel = (lists.types.find((t: any) => t.key === type) as any)?.label || type;
    const areaLabel = area ? ((lists.areas.find((a: any) => a.key === area) as any)?.label || area) : "Not sure";
    let emailed = true;
    try {
      const rows: [string, string][] = [["From", esc(who.name)]];
      if (who.store) rows.push(["Store", esc(who.store)]);
      rows.push(["Area", esc(areaLabel)], ["Sent", esc(whenNow())]);
      await sendMail(await recipients(sb), `New ticket SN-${row.id}: ${typeLabel} — ${who.name}`,
        emailShell(`NEW TICKET · SN-${row.id}`, esc(`${typeLabel}: ${row.title}`), rows, desc, file,
          { href: `${SITE}/dev.html#SN-${row.id}`, label: `Open SN-${row.id}` },
          "Sent from Submit a Ticket on SPEEKSNET. It's waiting in Triage on the Development page."));
    } catch (_) { emailed = false; }

    return json({ success: true, ticket: row, emailed, attachment: !!file });
  }

  // ---- POST without a PIN: the old email-only form (see the header) ----
  const name = String(form.get("Name") || "").trim().slice(0, 120);
  const rawCat = String(form.get("Category") || "").trim();
  const category = CATEGORIES.includes(rawCat) ? rawCat : "Other";
  const desc = String(form.get("Idea_Description") || "").trim().slice(0, 10000);
  const store = String(form.get("Store") || "").trim().toUpperCase().slice(0, 10);
  if (!name) return json({ success: false, error: "Your name is missing — try signing out and back in." }, 400);
  if (!desc) return json({ success: false, error: "Please describe your idea." }, 400);
  // 2026-11-25: "Tool Based" ideas name their tool — an MPL idea about the
  // Picture Guide arrived with nothing to say so. The popup only enables
  // "Which Tool?" for this category, listing the tools the person's role has
  // (Feature Access), so the name is free text here, capped. A tool sent with
  // any other category is ignored, and Tool Based without one is refused rather
  // than mailed as an idea about nothing in particular.
  const tool = category === "Tool Based"
    ? String(form.get("Tool") || "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (category === "Tool Based" && !tool) return json({ success: false, error: "Pick which tool it's about." }, 400);

  let file: FileRef | null = null;
  if (hasFile) {
    const r = await storeFile(sb, att as File, "");
    if (typeof r === "string") return json({ success: false, error: r }, r.includes("10 MB") ? 400 : 500);
    file = r;
  }
  const to = await recipients(sb);
  try {
    const rows: [string, string][] = [];
    if (tool) rows.push(["Tool", esc(tool)]);
    rows.push(["From", esc(name)]);
    if (store) rows.push(["Store", esc(store)]);
    rows.push(["Sent", esc(whenNow())]);
    // The tool leads the subject and the heading, so it reads from the inbox list.
    await sendMail(to, `New SPEEKS Idea: ${tool ? `${tool} — ` : ""}${category} — ${name}`,
      emailShell("NEW IDEA", esc(tool ? `${tool} · ${category}` : category), rows, desc, file, null,
        "Sent from Submit an Idea on SPEEKSNET."));
  } catch (e) {
    return json({ success: false, error: `The email did not send (${String((e as Error)?.message || e)}).` }, 502);
  }
  return json({ success: true, to: to.length, attachment: !!file });
});
