import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// IDEA SUBMIT — the Submit an Idea popup posts here.
// ----------------------------------------------------------------------------
// It used to post to formsubmit.co into a hidden iframe. The popup could only
// say "Submitted" once that free outside service finished answering, so it sat
// on "Sending..." for as long as formsubmit felt like (worse with an attachment,
// forever if it never answered), and it said "Submitted" on ANY page load —
// formsubmit's error page included. Reported slow 2026-11-05.
//
// Now: one multipart POST (Name, Category, Idea_Description, optional
// Attachment — the same field names the old form used). The file goes to the
// private `idea-attachments` bucket (0173) and the email carries a signed link,
// because the Gmail relay takes to/subject/html and nothing else. Recipients
// come from the `idea_submissions` list (Email Recipients tool) read here,
// server side, so the browser no longer has to fetch the list before Submit.
//
// Answers {success:true} only once the relay has accepted the mail, so the
// popup's "Submitted" is now true, and a failure comes back as an error the
// popup can show instead of a false confirmation.
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
const CATEGORIES = ["New Feature", "Process Improvement", "Bug Fix / Issue", "Other"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function buildEmail(name: string, category: string, desc: string, store: string,
  file: { name: string; url: string } | null): string {
  const when = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#64707c;font-size:13px;white-space:nowrap;vertical-align:top;">${k}</td>` +
    `<td style="padding:6px 0;color:#1a1c1e;font-size:14px;font-weight:600;">${v}</td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f1f5f2;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f2;padding:24px 12px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #eaefeb;border-radius:12px;">
  <tr><td style="padding:20px 24px 8px;"><div style="font-size:12px;color:#1f9d57;font-weight:700;letter-spacing:.04em;">NEW IDEA</div>
    <div style="font-size:20px;color:#1a1c1e;font-weight:800;margin-top:4px;">${esc(category)}</div></td></tr>
  <tr><td style="padding:8px 24px;"><table cellpadding="0" cellspacing="0">
    ${row("From", esc(name))}${store ? row("Store", esc(store)) : ""}${row("Sent", esc(when))}
  </table></td></tr>
  <tr><td style="padding:8px 24px 16px;"><div style="background:#f7faf8;border:1px solid #eaefeb;border-radius:8px;padding:14px 16px;color:#1a1c1e;font-size:14px;line-height:1.5;white-space:pre-wrap;">${esc(desc)}</div></td></tr>
  ${file ? `<tr><td style="padding:0 24px 20px;font-size:13px;color:#64707c;">Attachment: <a href="${esc(file.url)}" style="color:#1f9d57;font-weight:700;">${esc(file.name)}</a></td></tr>` : ""}
  <tr><td style="padding:14px;text-align:center;color:#9aa6ad;font-size:10.5px;border-top:1px solid #eaefeb;background:#f7faf8;">Sent from Submit an Idea on SPEEKSNET.</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST only" }, 405);

  let form: FormData;
  try { form = await req.formData(); }
  catch { return json({ success: false, error: "Could not read the form." }, 400); }

  const name = String(form.get("Name") || "").trim().slice(0, 120);
  const rawCat = String(form.get("Category") || "").trim();
  const category = CATEGORIES.includes(rawCat) ? rawCat : "Other";
  const desc = String(form.get("Idea_Description") || "").trim().slice(0, 10000);
  const store = String(form.get("Store") || "").trim().toUpperCase().slice(0, 10);
  if (!name) return json({ success: false, error: "Your name is missing — try signing out and back in." }, 400);
  if (!desc) return json({ success: false, error: "Please describe your idea." }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Attachment first: a file that fails to store should stop the send, not
  // arrive as an idea that says "see attached" with nothing attached.
  let file: { name: string; url: string } | null = null;
  const att = form.get("Attachment");
  if (att && att instanceof File && att.size > 0) {
    if (att.size > MAX_FILE) return json({ success: false, error: "That file is over 10 MB — please attach a smaller one." }, 400);
    const safe = att.name.replace(/[^\w.\-]+/g, "_").slice(-80) || "attachment";
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safe}`;
    const up = await sb.storage.from(BUCKET).upload(path, att, { contentType: att.type || undefined });
    if (up.error) return json({ success: false, error: `Attachment upload failed: ${up.error.message}` }, 500);
    const signed = await sb.storage.from(BUCKET).createSignedUrl(path, LINK_TTL);
    if (signed.error || !signed.data?.signedUrl) {
      return json({ success: false, error: "Attachment saved but its link could not be made." }, 500);
    }
    file = { name: att.name || safe, url: signed.data.signedUrl };
  }

  const { data: recips } = await sb.from("email_recipients").select("email").eq("list_key", LIST_KEY);
  const listed = (recips || []).map((r: any) => String(r.email || "").trim()).filter(Boolean);
  const to = listed.length ? listed : FALLBACK_TO;

  try {
    // redirect: 'manual' — the relay answers with a 302 to an echo URL that can
    // 404 AFTER the mail went. A 3xx is a send; following it would report a
    // delivered idea as failed and invite a duplicate resubmit.
    const res = await fetch(GMAIL_RELAY, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        secret: SECRET, to: to.join(","),
        subject: `New SPEEKS Idea: ${category} — ${name}`,
        html: buildEmail(name, category, desc, store, file),
      }),
    });
    if (!(res.status >= 300 && res.status < 400) && !res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`relay ${res.status}: ${t.slice(0, 160)}`);
    }
  } catch (e) {
    return json({ success: false, error: `The email did not send (${String((e as Error)?.message || e)}).` }, 502);
  }

  return json({ success: true, to: to.length, attachment: !!file });
});
