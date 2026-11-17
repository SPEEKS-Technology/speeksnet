import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildBoostEmail, type BoostRow } from "./email.ts";

// =============================================================================
// fb-boost-report — weekly email: Facebook Marketplace boosts (2026-11-13)
// =============================================================================
// Ethan: "if we do boost a listing, is there a way to record that we boosted a
// listing and for how long, and we need a notify me maybe via email report".
//
// Facebook never tells us about a boost — it's a paid ad bought on the
// person's own account — so staff record it with "Mark Boosted" in the
// Marketplace Lister's Listed tab (days + total budget). fb-lister writes it
// to fb_listings (migration 0183). This reads it once a week.
//
// THE WEEK is the last full Monday–Sunday in Central time, sent Monday
// morning. Kept short at Ethan's word (11-13): three tiles (boosted amount
// started that week, boosts started, running now + how many end within 3
// days) and one By Store table of open boosts and their boosted amount. The
// item lists and sold outcomes were in the first draft and taken out.
//
// SENT through the Gmail relay like every other report (no notify_queue), to
// Email Recipients list 'fb_boosts' (falls back to 'claims_disputes_dm' while
// that list is empty, so it reaches the DM rather than nobody).
//
//   ?secret=…                     build and send (cron)
//   ?secret=…&html=1              return the HTML, send nothing (preview)
//   ?secret=…&to=a@b.com          send only to that address
// =============================================================================

const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";
const LIST_KEY = "fb_boosts";
const FALLBACK_KEY = "claims_disputes_dm";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

function authed(url: URL) {
  const g = url.searchParams.get("secret") || "";
  if (g.length !== OPS_SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < OPS_SECRET.length; i++) d |= g.charCodeAt(i) ^ OPS_SECRET.charCodeAt(i);
  return d === 0;
}

// Last full Monday–Sunday, Central. Dates are read at noon UTC so a weekday
// is the calendar day's own, not a timezone's opinion of it.
function lastWeek() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const d = new Date(today + "T12:00:00Z");
  const dow = d.getUTCDay();                       // 0 = Sunday
  const thisMonday = new Date(d); thisMonday.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  const start = new Date(thisMonday); start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(thisMonday); end.setUTCDate(end.getUTCDate() - 1);
  const ymd = (x: Date) => x.toISOString().slice(0, 10);
  // As instants: Monday 00:00 → next Monday 00:00 Central (~06:00 UTC; an hour
  // off around a DST change, which only moves a boost made at midnight).
  return { weekStart: ymd(start), weekEnd: ymd(end), from: `${ymd(start)}T06:00:00Z`, to: `${ymd(thisMonday)}T06:00:00Z` };
}

async function relay(to: string, subject: string, html: string) {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 4000));
    try {
      // redirect:"manual" — a 302 is proof the relay ran; following it can 404
      // AFTER the mail went (see refund-mismatch).
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

async function recipients(): Promise<string[]> {
  for (const k of [LIST_KEY, FALLBACK_KEY]) {
    const { data } = await sb.from("email_recipients").select("email").eq("list_key", k);
    const list = (data || []).map((r: any) => String(r.email).trim()).filter(Boolean);
    if (list.length) return list;
  }
  return [];
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!authed(url)) return json({ error: "unauthorized" }, 401);
  const wk = lastWeek();
  const nowIso = new Date().toISOString();

  // Boosts started in the week, plus any still running now.
  const { data, error } = await sb.from("fb_listings")
    .select("store_code, sku, title, price, boosted_at, boost_ends_at, boost_days, boost_budget, boosted_by, done_at")
    .not("boosted_at", "is", null)
    .or(`boosted_at.gte.${wk.from},boost_ends_at.gt.${nowIso}`)
    .limit(1000);
  if (error) return json({ error: error.message }, 500);

  const rows: BoostRow[] = (data || []).map((r: any) => ({
    store: r.store_code, sku: r.sku, title: r.title || r.sku, price: r.price,
    boostedAt: r.boosted_at, endsAt: r.boost_ends_at, days: r.boost_days, budget: Number(r.boost_budget) || 0,
    boostedBy: r.boosted_by, doneAt: r.done_at,
  }));
  const inWeek = (iso: string) => iso >= wk.from && iso < wk.to;
  const t = Date.now();
  const report = {
    weekStart: wk.weekStart, weekEnd: wk.weekEnd, now: nowIso,
    started: rows.filter((r) => inWeek(r.boostedAt)),
    // Open = not ended yet and still on the store's Listed list.
    running: rows.filter((r) => Date.parse(r.endsAt) > t && !r.doneAt),
  };
  const html = buildBoostEmail(report);
  if (url.searchParams.get("html") === "1") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });

  const to = url.searchParams.get("to") || (await recipients()).join(",");
  if (!to) return json({ error: "no recipients" }, 500);
  const fmt = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const subject = `Facebook Boosts · Week of ${fmt(wk.weekStart)} – ${fmt(wk.weekEnd)}`;
  const sent = await relay(to, subject, html);
  return json({ ...sent, to, week: wk, counts: { started: report.started.length, running: report.running.length } });
});
