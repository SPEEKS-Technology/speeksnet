// claims-disputes-email — the mail side of the Claims & Disputes tool.
//
// FOUR SENDS, ONE FUNCTION, ?kind= picks which. Since 0119 every one of them
// carries Payments too — Shopify orders we have not been paid for — and a card
// on its last chargeable day is "due today" for both 4pm mails, the same as a
// dispute (Ethan, 2026-09-28). Since 2026-10-02 "due today" means the deadline
// is today OR TOMORROW — see dueSoon.
//
//   manager_daily   08:20 CT  to each store's manager. Everything of theirs that
//                             needs a person, soonest deadline first.
//   manager_nudge   16:00 CT  to a store, ONLY when something is due today, it
//                             was on this morning's mail, and it still has not
//                             been answered. Answer it and this never arrives.
//   dm_digest       08:20 CT  to the DM. Counts per store, plus the two things a
//                             manager cannot fix on their own.
//   dm_due_today    16:00 CT  to the DM (Ethan, 2026-09-23: "anything that is due
//                             today to send an email to the DM at 4:00pm central
//                             as well saying that a store has something due today
//                             and it hasn't been done yet, so I can contact the
//                             store about it"). The same trigger as the nudge,
//                             addressed to the person who makes the phone call.
//
// ⚠️ THIS FUNCTION DOES NOT DECIDE WHAT IS DUE. It asks claims-disputes, which
// runs stateOf, and mails what comes back. That is the whole point of there
// being one visibility rule: if the mail worked out for itself what "needs a
// reply" meant, the tab and the inbox would start disagreeing, and a manager who
// cleared their tab would keep getting mail about it. The ONLY thing read here
// that stateOf did not decide is `quiet_until` — and stateOf sets that too.
//
// READ-ONLY AGAINST EBAY AND SHOPIFY, like everything else in this feature: it
// reads one SPEEKSNET endpoint, writes hold_email_log, and posts to the Gmail
// relay. It never touches a marketplace.
//
// WHAT IT WRITES. One hold_email_log row per ITEM per send (0114). Those rows
// are what make "new since yesterday", the nudge's "nothing has changed", the
// INR quiet rule and the DM's shown-once possible. A send that had nothing to
// say writes nothing, which is how "we said nothing today" stays true.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://ejzaqmyxxrkmxvzbjeuo.supabase.co";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";
// The same hard-coded ops secret the other ~10 functions carry. Not a new
// exposure; changing it is a separate job across all of them.
const OPS_SECRET = "sp33ks-sync-k3y-2026-x9mq";
const TOOL_URL = "https://speeksnet.com";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const STORE_NAME: Record<string, string> = {
  OVL: "Overland Park", LEE: "Lee's Summit", WSP: "Westport", MPL: "Maplewood", BAL: "Ballwin",
};
// The Shopify admin is keyed by the shop handle, never the store code — the same
// map the front end uses, for the same reason: a link that 404s is worse than no
// link at all.
const SHOP_HANDLE: Record<string, string> = {
  OVL: "paymore-overland-park", LEE: "paymore-lees-summit", WSP: "paymore-westport",
  MPL: "paymore-maplewood", BAL: "paymore-ballwin",
};

// --- the house look ---------------------------------------------------------
// Lifted from refund-mismatch, which this replaces. Every SPEEKS report looks
// like this; a mail that invents its own palette reads as somebody else's.
const C = { ink: "#12241c", faint: "#5b7166", line: "#dde7e1", bad: "#b3261e", warn: "#8a5a00", chip: "#eef5f1" };
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pretty = (v: unknown) => {
  // eBay sends these as shouting enums, often as a pair: "SNAD · MISSING_PARTS".
  // SNAD is its acronym for "significantly not as described"; lower-cased with
  // everything else it reads as the non-word "Snad" in a sentence written for a
  // person. Expanding it makes "SNAD · NOT_AS_DESCRIBED" say the same thing
  // twice, so identical halves collapse to one.
  const seen = new Set<string>();
  const parts = String(v ?? "")
    .replace(/SNAD/gi, "Not as described")
    .replace(/_/g, " ")
    .split("·")
    .map((x) => x.trim())
    .filter((x) => {
      const k = x.toLowerCase();
      if (!x || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const t = parts.join(" · ");
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : "";
};
const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : "";
};

// --- Chicago calendar days (the same arithmetic the tool uses) ---------------
const chicagoDay = (d: Date | string | null) => {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(dt);
};
const addDaysIso = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};
const prettyDay = (iso: string) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d)));
};

// ---------------------------------------------------------------------------
// The item shapes, flattened out of what claims-disputes returns so the
// templates below never have to know which of the three lists a row came from.
// ---------------------------------------------------------------------------
type Row = {
  type: string; key: string; store: string; state: string; note: string | null;
  kindLabel: string; title: string; facts: string[]; amount: number | null;
  due: string; link: string; linkLabel: string; quiet: string | null; missed: boolean;
  contestedSince: string | null; openedAt: string;
  // A payment's deadline is a card running out, not a reply (0119), so it
  // carries its own words for "answer by" and "reply window shut".
  dueVerb?: string; missedText?: string;
};

// The states that mean a person still has to do something. Identical to the
// tool's "Needs Attention" view, because it is the same question.
const NEED = ["needs_reply", "needs_claim", "due"];

function disputeRow(d: any): Row {
  const ebay = d.source === "ebay";
  const handle = SHOP_HANDLE[d.store_code];
  return {
    type: "dispute", key: d.dispute_key, store: d.store_code, state: d.state, note: d.state_note || null,
    kindLabel: ebay ? "eBay payment dispute" : "Shopify chargeback",
    title: d.item_title || pretty(d.reason) || (ebay ? "Payment dispute" : "Chargeback"),
    facts: [
      d.order_no ? `Order ${d.order_no}` : "",
      d.reason_code ? `Network code ${d.reason_code}` : "",
      d.buyer ? `Buyer ${d.buyer}` : "",
    ].filter(Boolean),
    amount: d.amount == null ? null : Number(d.amount),
    due: chicagoDay(d.respond_by),
    link: ebay ? "https://www.ebay.com/sh/return/disputes"
               : handle ? `https://admin.shopify.com/store/${handle}/payments/disputes` : "",
    linkLabel: ebay ? "Respond on eBay" : "Respond in Shopify",
    quiet: d.quiet_until || null, missed: !!d.missed_window,
    contestedSince: d.resolution_disputed_since || null, openedAt: d.opened_at || "",
  };
}

function caseRow(c: any): Row {
  const inr = c.kind === "inquiry" || (c.kind === "case" && c.case_type === "ITEM_NOT_RECEIVED");
  const escalated = c.kind === "case";
  return {
    type: "ebay_case", key: c.case_key, store: c.store_code, state: c.state, note: c.state_note || null,
    kindLabel: c.state === "needs_claim" ? "Refunded item not received"
      : c.state_note === "delivered_after_refund" ? "Delivered after we refunded"
      : inr ? (escalated ? "Item not received — escalated" : "Item not received")
      : "eBay case",
    title: c.item_title || (inr ? "Item not received" : "eBay case"),
    facts: [
      c.order_no ? `Order ${c.order_no}` : "",
      c.buyer ? `Buyer ${c.buyer}` : "",
      c.reason ? pretty(c.reason) : "",
    ].filter(Boolean),
    amount: c.amount == null ? null : Number(c.amount),
    // A refunded INR has met its eBay deadline — that is WHY it was refunded.
    // Carrying the date forward would mark it late for something already done,
    // and would let it count towards "closes today". What is outstanding is the
    // claim, and a claim has no deadline of its own.
    due: c.state === "needs_claim" || c.state_note === "delivered_after_refund" ? "" : chicagoDay(c.respond_by),
    link: "", linkLabel: "",
    quiet: c.quiet_until || null, missed: !!c.missed_window,
    contestedSince: c.resolution_disputed_since || null, openedAt: c.opened_at || "",
  };
}

function mismatchRow(m: any): Row {
  const ebayOnly = m.direction === "ebay_only";
  return {
    type: "mismatch", key: m.issue_key, store: m.store_code, state: m.state, note: m.state_note || null,
    kindLabel: "Refund mismatch",
    title: ebayOnly ? "Refunded on eBay, but not on Shopify" : "Refunded on Shopify, but not on eBay",
    facts: [
      m.ebay_order_id ? `eBay order ${m.ebay_order_id}` : "",
      m.shopify_order_name ? `Shopify ${m.shopify_order_name}` : "",
    ].filter(Boolean),
    amount: m.amount == null ? null : Number(m.amount),
    due: "", link: "", linkLabel: "",
    quiet: m.quiet_until || null, missed: false,
    contestedSince: m.resolution_disputed_since || null, openedAt: m.reversed_at || "",
  };
}

// PAYMENTS (0119). A Shopify order we have not been paid for. Its deadline is
// the card authorization running out — the one day Shopify can still charge it
// — which is what puts it in the 4pm mails on its last day, exactly like a
// dispute due today (Ethan, 2026-09-28: "keep this the same as payment disputes
// and ... add this to the morning email and the reminders for both manager and
// dm for things due today"). One the card can no longer be charged for has no
// deadline left: it is `missed`, so it rides the morning mail and the DM hears
// about it once, and it never triggers a 4pm "closes today".
function paymentRow(p: any): Row {
  const handle = SHOP_HANDLE[p.store_code];
  const partial = p.financial_status === "PARTIALLY_PAID";
  return {
    type: "payment", key: p.order_key, store: p.store_code, state: p.state, note: p.state_note || null,
    kindLabel: p.capturable ? "Card not charged yet" : partial ? "Partially paid" : "Card expired — not collected",
    title: p.item_title || p.order_name || "Shopify order",
    facts: [
      p.order_name ? `Order ${p.order_name}` : "",
      partial ? `${money(p.received)} of ${money(p.total)} collected` : "",
      Number(p.unfulfilled_items) > 0 ? `${p.unfulfilled_items} not shipped` : "",
    ].filter(Boolean),
    amount: p.amount == null ? null : Number(p.amount),
    due: p.capturable ? chicagoDay(p.auth_expires_at) : "",
    link: handle && p.order_id ? `https://admin.shopify.com/store/${handle}/orders/${p.order_id}` : "",
    linkLabel: "Open in Shopify",
    quiet: p.quiet_until || null, missed: !!p.missed_window,
    contestedSince: p.resolution_disputed_since || null, openedAt: p.ordered_at || "",
    // "Card expired — not collected · card expired" said it twice, so the tag
    // is only added where the label does not already say it.
    dueVerb: "charge the card by", missedText: partial ? "card expired" : "",
  };
}

// A plain return is a list to read, not a list to work (Ethan, 2026-09-22), and
// the stores go through them every morning anyway. They are counted, never
// itemised, so they cannot bury the things that do need doing.
const isPlainReturn = (c: any) => c.kind === "return";

async function fetchState(): Promise<any> {
  const u = `${SUPABASE_URL}/functions/v1/claims-disputes?stores=${STORES.join(",")}&secret=${encodeURIComponent(OPS_SECRET)}`;
  const res = await fetch(u, { headers: { "Content-Type": "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success === false) {
    throw new Error(`claims-disputes read failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// FRESHNESS (Ethan 2026-09-29: "I'm having everyone rely on this directly").
//
// The list is a mirror, and until now the mirror was only refreshed when
// somebody opened the tab. Nothing scheduled a read, and nothing said how old
// the list was, so a morning mail could be built off yesterday's sweep and look
// exactly as trustworthy as a fresh one.
//
// So every real send READS FIRST: it asks claims-disputes for a sweep of all
// five stores (the normal 20-minute throttle applies, so a tab opened a minute
// ago is not re-read), then builds the mail from what that left. A full sweep
// took ~11s on 2026-09-29; the cap below is far above that and still well
// inside this function's own limit. A sweep that fails or overruns does NOT
// stop the mail — a stale mail is better than none — it makes the mail SAY so.
//
// Two sends firing in the same minute (the 8:20 pair) can both sweep. Harmless:
// the sweep only upserts, so the second is a repeat, not a conflict.
// ---------------------------------------------------------------------------
const STALE_HOURS = 6;
const SYNC_CAP_MS = 100_000;

async function refresh(): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SYNC_CAP_MS);
  try {
    const u = `${SUPABASE_URL}/functions/v1/claims-disputes?action=sync&stores=ALL&secret=${encodeURIComponent(OPS_SECRET)}`;
    const res = await fetch(u, { signal: ctl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.success === false) {
      return `the read before this mail failed (${res.status}): ${String(body?.error ?? "").slice(0, 160)}`;
    }
    return null;
  } catch (e) {
    return ctl.signal.aborted ? `the read before this mail did not finish in ${SYNC_CAP_MS / 1000}s`
      : `the read before this mail failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
  } finally {
    clearTimeout(timer);
  }
}

// Per store, every reason its list cannot be trusted as current: a source that
// failed, one never read, or one older than STALE_HOURS. Read from the same
// sync rows the tab shows, so the mail and the tab cannot disagree about it.
function staleness(d: any, now = Date.now()): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (s: string, why: string) => (out[s] ||= []).push(why);
  const check = (s: string, label: string, r: any) => {
    if (!r) { add(s, `${label} has never been read`); return; }
    if (!r.ok) { add(s, `${label} could not be read (${String(r.detail || "no reason given").slice(0, 120)})`); return; }
    const h = (now - Date.parse(r.synced_at)) / 3_600_000;
    if (!(h <= STALE_HOURS)) add(s, `${label} last read ${isFinite(h) ? Math.round(h) + " hours ago" : "at an unknown time"}`);
  };
  for (const s of STORES) {
    check(s, "eBay returns and cases", (d.sync || []).find((r: any) => r.store_code === s));
    const ds = (d.disputeSync || []).filter((r: any) => r.store_code === s);
    check(s, "eBay payment disputes", ds.find((r: any) => r.source === "ebay"));
    check(s, "Shopify chargebacks", ds.find((r: any) => r.source === "shopify"));
    check(s, "Shopify unpaid orders", (d.paymentSync || []).find((r: any) => r.store_code === s));
  }
  return out;
}

// A red row straight under the header. Inserted rather than threaded through
// every template, so all four mails carry it identically.
function withWarning(html: string, lines: string[]): string {
  if (!lines.length) return html;
  const row = `<tr><td style="padding:12px 14px;background:#ffffff;border-top:3px solid #b3261e;">
      <div style="font-size:13px;font-weight:800;color:${C.bad};">This list may be out of date</div>
      <div style="font-size:12px;color:${C.ink};margin-top:5px;line-height:1.6;">${lines.map(esc).join("<br>")}</div>
      <div style="font-size:12px;color:${C.faint};margin-top:6px;line-height:1.6;">Anything that arrived since then is not below. Check eBay and Shopify directly today.</div>
    </td></tr>`;
  const i = html.indexOf("</td></tr>");
  return i < 0 ? html : html.slice(0, i + 10) + row + html.slice(i + 10);
}

// ---------------------------------------------------------------------------
// BACKUPS RIDE ON THE DM DIGEST (Ethan, 2026-09-30: "put it in an existing email
// and only alert me when it's after a certain time"). Nothing to do with claims —
// this is simply the one mail that reaches Ethan alone every morning. The backup
// script posts a backup_runs row (0120) after each run; when the newest GOOD one
// is older than BACKUP_STALE_HOURS the digest gets a red "Backups" row, and it is
// sent even on a morning with no claims to report. Otherwise it adds nothing.
//
// 48 hours: the backup runs at 2am, or on the next unlock if the laptop was
// closed, so one missed night is routine and two in a row is not. From Sep 22
// to Sep 30 it went nine nights without one and nobody knew.
// ---------------------------------------------------------------------------
const BACKUP_STALE_HOURS = 48;

async function backupWarning(now = Date.now()): Promise<string[]> {
  const fix = "Open or unlock the laptop so it can catch up; if it still does not, the reason is in BACKUP-PROBLEM.txt under %LOCALAPPDATA%\\SPEEKSNET Backup, or in LAST-BACKUP.txt in the Drive backups folder.";
  try {
    const rows = await sb(`backup_runs?select=finished_at,snapshot&ok=eq.true&order=finished_at.desc&limit=1`,
      { headers: { Prefer: "return=representation" } }) || [];
    if (!rows.length) return [`No complete SPEEKSNET backup has ever been recorded. ${fix}`];
    const h = (now - Date.parse(rows[0].finished_at)) / 3_600_000;
    if (h <= BACKUP_STALE_HOURS) return [];
    const when = new Date(rows[0].finished_at).toLocaleString("en-US", {
      timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    return [`The last complete SPEEKSNET backup was ${Math.floor(h / 24)} days ago (${when}, folder ${rows[0].snapshot}). ${fix}`];
  } catch (e) {
    // Saying so beats staying quiet: a check that cannot run is how Sep 22-30 happened.
    return [`Could not check the SPEEKSNET backups: ${String((e as Error)?.message ?? e).slice(0, 160)}`];
  }
}

function withBackupWarning(html: string, lines: string[]): string {
  if (!lines.length) return html;
  const row = `<tr><td style="padding:12px 14px;background:#ffffff;border-top:3px solid #b3261e;">
      <div style="font-size:13px;font-weight:800;color:${C.bad};">Backups</div>
      <div style="font-size:12px;color:${C.ink};margin-top:5px;line-height:1.6;">${lines.map(esc).join("<br>")}</div>
    </td></tr>`;
  const i = html.indexOf("</td></tr>");
  return i < 0 ? html : html.slice(0, i + 10) + row + html.slice(i + 10);
}

function allRows(d: any): Row[] {
  return [
    ...(d.disputes || []).map(disputeRow),
    ...(d.cases || []).filter((c: any) => !isPlainReturn(c)).map(caseRow),
    ...(d.mismatches || []).map(mismatchRow),
    ...(d.payments || []).map(paymentRow),
  ];
}

// WHAT IS ALLOWED IN A MAIL TODAY. Needing a person, and not inside its quiet
// window. quiet_until is the INR rule (Ethan, 2026-09-23: "once they are
// notified about it via email, they don't need to see it again until the day of
// needing to refund") — set by stateOf, only ever read here.
// Quiet ends a day before the refund day, not on it — see DUE TODAY MEANS BY
// TOMORROW below. Otherwise an INR would be hidden on the very day it is meant
// to be called due.
const mailable = (r: Row, today: string) => NEED.includes(r.state) && !(r.quiet && r.quiet > addDaysIso(today, 1));

// DUE TODAY MEANS BY TOMORROW (Ethan, 2026-10-02: "something due tomorrow we
// would get alerted as due today today, so keep everything the same just move it
// a day forward"). What prompted it: OVL #KS01-15083's card ran out at 11:04 AM
// on Oct 1. It was "due today" on the 8:20 mails, but by 4pm it was already
// missed, so neither 4pm alert said a word about it. The next morning it turned
// up as "worth a conversation", which looked like a different list from the one
// the 4pm alert had been about. Card deadlines fall at whatever time the order
// was placed, so most are gone before 4pm on their own day. Calling them due
// the day BEFORE gives each one a full day of morning mail and a 4pm alert while
// it can still be charged. An item stays "due today" on its real day as well,
// until it is dealt with or missed. The real date is still printed on the item.
const dueSoon = (r: Row, today: string) =>
  !!r.due && !r.missed && r.due >= today && r.due <= addDaysIso(today, 1);

// Soonest deadline first, then oldest, then biggest. A thing closing tonight
// belongs above a thing closing in three weeks whatever type it is — Ethan's
// "deadline order, not type order".
const bySoonest = (a: Row, b: Row) =>
  (a.due || "9999").localeCompare(b.due || "9999")
  || String(a.openedAt).localeCompare(String(b.openedAt))
  || (b.amount || 0) - (a.amount || 0);

// ---------------------------------------------------------------------------
// The house shell
// ---------------------------------------------------------------------------
// DARK MODE (Ethan's phone, 2026-10-01). Outlook on iOS doesn't honour a dark
// stylesheet; it inverts the light colours itself. Two things in the old shell
// broke under that:
//   * the header band was a pale tint (#fbeceb pink, #eef5f1 green). Inverted,
//     a tint turns muddy — the 4pm alert came out brown, with the grey subtitle
//     almost invisible on it. The band is now plain white, which inverts to the
//     same dark as the rest of the card, and the alert says "alert" with a red
//     rule along the top plus its red title, both of which survive inversion.
//   * <body> had 18px of padding and the card was width:600px; max-width:100%.
//     On a phone that is 100% of the body PLUS the padding, so the card ran
//     past the grey ground on the right, and the light grey turned into a
//     mid-grey slab. The ground is now a full-width white table and the card
//     a fluid table capped at 600px, so nothing can overhang anything.
// Keep any new band or row on white (or the near-white #f7faf8 already used for
// section rows) — no new tints.
function shell(title: string, sub: string, body: string, foot: string, alert = false) {
  const accent = alert ? C.bad : "#1c6b47";
  return `<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;"><tr><td align="center" style="padding:12px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;background:#ffffff;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;">
    <tr><td style="padding:16px 14px;background:#ffffff;border-top:4px solid ${accent};border-radius:12px 12px 0 0;">
      <div style="font-size:17px;font-weight:800;color:${alert ? C.bad : C.ink};">${title}</div>
      <div style="font-size:12.5px;color:${C.faint};margin-top:5px;line-height:1.6;">${sub}</div>
    </td></tr>
    ${body}
    <tr><td style="padding:12px 14px;text-align:center;color:${C.faint};font-size:10.5px;line-height:1.6;border-top:1px solid ${C.line};background:#f7faf8;border-radius:0 0 12px 12px;">${foot}</td></tr>
  </table>
</td></tr></table>
</body>`;
}

const sectionRow = (label: string, color = C.faint) =>
  `<tr><td style="padding:10px 14px;border-top:1px solid ${C.line};background:#f7faf8;">
     <div style="font-size:11px;color:${color};letter-spacing:.04em;text-transform:uppercase;font-weight:700;">${esc(label)}</div>
   </td></tr>`;

function itemRow(r: Row, today: string) {
  const late = r.due && r.due < today;
  const todayDue = r.due && r.due === today;
  // Due a day early (dueSoon), but the real deadline is still what is printed.
  const tomorrowDue = r.due && r.due === addDaysIso(today, 1);
  const dueTxt = r.missed
    ? (r.missedText === "" ? "" : `<span style="color:${C.bad};font-weight:700;"> · ${esc(r.missedText || "reply window shut")}</span>`)
    : todayDue ? `<span style="color:${C.bad};font-weight:700;"> · closes today</span>`
    : tomorrowDue ? `<span style="color:${C.bad};font-weight:700;"> · due today — closes tomorrow</span>`
    : late ? `<span style="color:${C.bad};font-weight:700;"> · was due ${esc(prettyDay(r.due))}</span>`
    : r.due ? `<span style="color:${C.warn};font-weight:700;"> · ${esc(r.dueVerb || "answer by")} ${esc(prettyDay(r.due))}</span>` : "";
  const facts = r.facts.map(esc).join(" &nbsp;·&nbsp; ");
  const note = noteLine(r);
  const amt = r.amount == null ? "" : `<b>${money(r.amount)}</b>`;
  return `<tr><td style="padding:14px;border-top:1px solid ${C.line};">
    <div style="font-size:11px;color:${C.faint};letter-spacing:.04em;text-transform:uppercase;">${esc(r.kindLabel)}${dueTxt}</div>
    <div style="font-size:15px;font-weight:700;color:${C.ink};margin:4px 0 6px;">${esc(r.title)}</div>
    <div style="font-size:13px;color:${C.ink};line-height:1.6;">${[amt, facts].filter(Boolean).join(" &nbsp;·&nbsp; ")}
      ${note ? `<br><span style="color:${C.faint};">${esc(note)}</span>` : ""}
    </div>
    ${r.link ? `<div style="margin-top:8px;font-size:12px;"><a href="${esc(r.link)}" style="color:#1c6b47;">${esc(r.linkLabel)}</a></div>` : ""}
  </td></tr>`;
}

// The one-line "so what" under an item, in the same words the card uses.
function noteLine(r: Row): string {
  // A payment has no "response" — what matters is whether Shopify can still
  // charge the card, so it gets its own three lines, in the card's words.
  if (r.type === "payment") {
    if (r.note === "resolution_disputed") return "Someone marked this resolved, but Shopify can still charge the card — the order was not charged or cancelled.";
    if (r.missed) return "Shopify can't charge this card any more. Collect it another way, or cancel or refund what didn't ship.";
    return "Fulfil the order to charge the card, or cancel it if it isn't going.";
  }
  if (r.note === "delivered_after_refund")
    return "It turned up after we refunded the buyer. The carrier does not owe this one — call eBay, then record what they did.";
  if (r.note === "resolution_disputed")
    return "Someone marked this resolved and the site still shows no response.";
  if (r.note === "missed_window")
    return "No response was recorded before the deadline, and no late one is accepted.";
  if (r.state === "needs_claim")
    return "The buyer was refunded — open or link a claim. A note cannot close this one.";
  return "";
}

// ---------------------------------------------------------------------------
// 1. Manager daily
// ---------------------------------------------------------------------------
function managerDaily(store: string, rows: Row[], seen: Set<string>, extras: { returns: number; claims: number; quiet: number }, today: string) {
  const list = rows.slice().sort(bySoonest);
  const fresh = list.filter((r) => !seen.has(`${r.type}|${r.key}`));
  const rest = list.filter((r) => seen.has(`${r.type}|${r.key}`));
  const closing = list.filter((r) => dueSoon(r, today)).length;
  const total = list.reduce((s, r) => s + (r.amount || 0), 0);

  let body = `<tr><td style="padding:12px 14px;border-top:1px solid ${C.line};">
    <table role="presentation" width="100%"><tr>
      <td style="font-size:12px;color:${C.faint};"><b style="color:${C.ink};font-size:19px;">${list.length}</b><br>need you</td>
      <td style="font-size:12px;color:${C.faint};"><b style="color:${closing ? C.bad : C.ink};font-size:19px;">${closing}</b><br>due today</td>
      <td style="font-size:12px;color:${C.faint};text-align:right;"><b style="color:${C.ink};font-size:19px;">${money(total)}</b><br>at stake</td>
    </tr></table></td></tr>`;

  if (fresh.length) {
    body += sectionRow("New since yesterday");
    body += fresh.map((r) => itemRow(r, today)).join("");
  }
  if (rest.length) {
    body += sectionRow("Still waiting on you — soonest first", C.bad);
    body += rest.map((r) => itemRow(r, today)).join("");
  }

  const quiet: string[] = [];
  if (extras.returns) quiet.push(`${extras.returns} open return${extras.returns === 1 ? "" : "s"}`);
  if (extras.claims) quiet.push(`${extras.claims} claim${extras.claims === 1 ? "" : "s"} over 7 days`);
  // An INR that has been told about once and is waiting for its refund date is
  // not "nothing" — it is a date being kept. Saying so is what stops someone
  // thinking the tool forgot about it.
  if (extras.quiet) quiet.push(`${extras.quiet} item-not-received waiting on its refund date`);
  if (quiet.length) {
    body += `<tr><td style="padding:13px 14px;border-top:1px solid ${C.line};background:#f7faf8;font-size:12.5px;color:${C.faint};line-height:1.7;">
      <b style="color:${C.ink};">Also on your tab:</b> ${esc(quiet.join(" · "))}.</td></tr>`;
  }

  return shell(
    `${STORE_NAME[store] || store} — money we're still holding`,
    `Everything eBay or Shopify is still waiting on us for, soonest deadline first. Each one stays on this email every morning until the site itself shows it is dealt with.`,
    body,
    `Open the Claims &amp; Disputes tool at <a href="${TOOL_URL}" style="color:#1c6b47;">speeksnet.com</a>.<br>Marking something resolved does not remove it while eBay or Shopify still show it unanswered.`,
  );
}

// ---------------------------------------------------------------------------
// 2. The 4pm nudge, to the store
// ---------------------------------------------------------------------------
function managerNudge(store: string, rows: Row[], today: string) {
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const body = rows.sort(bySoonest).map((r) => itemRow(r, today)).join("");
  return shell(
    `${money(total)} due today`,
    // "Still open on the site" rather than "no response from us": since 0119 a
    // card that runs out today lands here too, and there is no reply to it.
    `${esc(STORE_NAME[store] || store)}. ${rows.length === 1 ? "This was" : "These were"} on your email this morning and ${rows.length === 1 ? "is" : "are"} still open on the site.`,
    body,
    `Sent at 4:00 PM only when something closes today or tomorrow and nothing has changed since the morning email.<br>Answer it — or charge or cancel the order — and this stops. The next read of the site clears it by itself.`,
    true,
  );
}

// ---------------------------------------------------------------------------
// 3. The DM digest
// ---------------------------------------------------------------------------
function dmDigest(byStore: Record<string, Row[]>, counts: Record<string, any>, newMissed: Row[], contested: Row[], today: string) {
  const col = (n: number, color?: string) =>
    `<td style="text-align:center;padding:0 3px;font-size:15px;font-weight:700;color:${n ? (color || C.ink) : "#c9d5cd"};">${n || "—"}</td>`;

  // SHORT HEADERS (Ethan's phone, 2026-10-02). Eight full-word headers with no
  // gap between cells ran together into "STOREDISPUTESINRSCASES…" at phone
  // width. Short single words with padding fit at 360px; the footer spells them out.
  const head = ["Store", "Disp", "INR", "Case", "Mism", "Pay", "Claims", "Due"];
  const last = head.length - 1;
  let table = `<tr><td style="padding:14px 12px;border-top:1px solid ${C.line};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>${head.map((h, i) => `<th style="text-align:${i ? "center" : "left"};padding:0 3px 7px;white-space:nowrap;font-size:10px;font-weight:700;letter-spacing:.03em;color:${i === last ? C.bad : C.faint};text-transform:uppercase;border-bottom:1.5px solid ${C.ink};">${esc(h)}</th>`).join("")}</tr>`;

  let any = false;
  for (const s of STORES) {
    const c = counts[s];
    if (!c || !(c.disputes || c.inrs || c.cases || c.mismatch || c.payments || c.claims || c.dueToday)) continue;
    any = true;
    table += `<tr>
      <td style="padding:11px 0;border-bottom:1px solid ${C.line};font-size:13px;font-weight:700;color:${C.ink};">${esc(s)}</td>
      ${col(c.disputes)}${col(c.inrs)}${col(c.cases)}${col(c.mismatch)}${col(c.payments)}${col(c.claims, C.warn)}${col(c.dueToday, C.bad)}
    </tr>`;
  }
  table += `</table></td></tr>`;
  if (!any) table = `<tr><td style="padding:16px 14px;border-top:1px solid ${C.line};font-size:13px;color:${C.ink};">Nothing is outstanding at any store this morning.</td></tr>`;

  let body = table;
  if (newMissed.length) {
    body += sectionRow("New — worth a conversation", C.bad);
    body += newMissed.map((r) => `<tr><td style="padding:14px;border-top:1px solid ${C.line};">
      <div style="font-size:11px;color:${C.faint};letter-spacing:.04em;text-transform:uppercase;">${r.type === "payment" ? "Uncollected payment" : "Missed reply window"}</div>
      <div style="font-size:15px;font-weight:700;color:${C.ink};margin:4px 0 6px;">${esc(r.store)} — ${money(r.amount)} ${esc(r.kindLabel)}</div>
      <div style="font-size:13px;color:${C.ink};line-height:1.6;">${esc(r.facts.join(" · "))}<br>
        <span style="color:${C.faint};">${r.type === "payment"
          ? "The card authorization ran out before the order was charged. The money has to be collected another way now."
          : "The deadline passed with no response recorded from the store."}</span></div>
    </td></tr>`).join("");
  }
  if (contested.length) {
    body += sectionRow("Needs manual review from you", C.warn);
    body += contested.map((r) => {
      const days = Math.max(0, Math.round((Date.parse(today) - Date.parse(chicagoDay(r.contestedSince))) / 86400000));
      return `<tr><td style="padding:14px;border-top:1px solid ${C.line};">
        <div style="font-size:11px;color:${C.faint};letter-spacing:.04em;text-transform:uppercase;">Marked resolved, site disagrees · day ${days}</div>
        <div style="font-size:15px;font-weight:700;color:${C.ink};margin:4px 0 6px;">${esc(r.store)} — ${money(r.amount)} ${esc(r.kindLabel)}</div>
        <div style="font-size:13px;color:${C.ink};line-height:1.6;">${esc(r.facts.join(" · "))}<br>
          <span style="color:${C.faint};">${r.type === "payment" ? "Shopify can still charge the card — it was not charged or cancelled." : "The site still shows no response."} Past the 2-day grace, so it came to you.</span></div>
      </td></tr>`;
    }).join("");
  }

  return shell(
    "What is still sitting with the managers",
    "Counts are items still needing a person to do something. Anything already answered or settled is left out.",
    body,
    `Disp = disputes · INR = item not received · Case = eBay cases · Mism = refund mismatches · Pay = unpaid orders · Claims = claims over 7 days · Due = deadline today or tomorrow.<br>Sent on the mornings the managers are emailed, so this is what went out to them today.<br>A store with nothing outstanding is left out of the table entirely.`,
  );
}

// ---------------------------------------------------------------------------
// 4. The DM's 4pm "due today and not done"
// ---------------------------------------------------------------------------
function dmDueToday(byStore: Record<string, Row[]>, today: string) {
  const stores = Object.keys(byStore).filter((s) => byStore[s].length).sort();
  const total = stores.reduce((s, k) => s + byStore[k].reduce((n, r) => n + (r.amount || 0), 0), 0);
  let body = "";
  for (const s of stores) {
    body += sectionRow(`${STORE_NAME[s] || s} — ${byStore[s].length} still open`, C.bad);
    body += byStore[s].sort(bySoonest).map((r) => itemRow(r, today)).join("");
  }
  return shell(
    `${money(total)} due today and still unanswered`,
    `${stores.length === 1 ? "One store has" : `${stores.length} stores have`} something whose deadline is today or tomorrow. ${
      stores.length === 1 ? "It was" : "They were"} on this morning's email and ${stores.length === 1 ? "is" : "are"} still open on the site.`,
    body,
    `Sent at 4:00 PM only when a deadline falls today or tomorrow and the store has not dealt with it.<br>Nothing here can be cleared from this email — the store has to answer it, or charge or cancel the order, on the site.`,
    true,
  );
}

// ---------------------------------------------------------------------------
async function sb(path: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function recipients(key: string): Promise<string[]> {
  const rows = await sb(`email_recipients?select=email&list_key=eq.${encodeURIComponent(key)}`,
    { headers: { Prefer: "return=representation" } });
  return (rows || []).map((r: any) => String(r.email).trim()).filter(Boolean);
}

// ⚠️ A 404 FROM THE RELAY DOES NOT MEAN THE MAIL WAS NOT SENT — see the long
// note in refund-mismatch. Apps Script answers the POST with a 302 to a one-time
// echo URL, and it is the ECHO that 404s. The redirect is not followed; the 302
// is itself proof doPost ran. Retrying on it would mail everyone twice.
async function relay(to: string, subject: string, html: string) {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 4000));
    try {
      const res = await fetch(GMAIL_RELAY, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ secret: OPS_SECRET, to, subject, html }),
        redirect: "manual",
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.ok || (status >= 300 && status < 400)) return { ok: true, status, attempts: attempt + 1 };
    } catch (e) {
      return { ok: false, status: 0, attempts: attempt + 1, error: String(e).slice(0, 120) };
    }
  }
  return { ok: false, status, attempts: 3 };
}

// Same broadcast claims-disputes sends after a write: open pages re-run their
// claims checks, which is what puts the 4pm card in the feed. Best-effort — the
// feed's own poll picks it up anyway.
async function pingFeed(store: string) {
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: [{ topic: "speeks-notify", event: "changed", payload: { tool: "claims", store, ts: Date.now() } }] }),
    });
  } catch (_) { /* best-effort */ }
}

async function logSent(kind: string, store: string, rows: Row[], today: string) {
  if (!rows.length) return;
  await sb("hold_email_log", {
    method: "POST",
    body: JSON.stringify(rows.map((r) => ({
      kind, store_code: store, item_type: r.type, item_key: r.key, state: r.state, sent_on: today,
    }))),
  });
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if ((url.searchParams.get("secret") || "") !== OPS_SECRET) return json({ error: "unauthorised" }, 401);

  const kind = String(url.searchParams.get("kind") || "manager_daily");

  // SAMPLE. Fixed rows, so every one of the four can be looked at on any day.
  // Two of them only exist when a deadline happens to fall today, which makes
  // them unviewable most of the time — no way to check a template somebody is
  // about to present. Reads nothing, writes nothing, sends nothing. The figures
  // are real ones from 2026-09-23.
  if (url.searchParams.get("sample") === "1") {
    const day = chicagoDay(new Date());
    const base: Row = {
      type: "dispute", key: "k", store: "WSP", state: "needs_reply", note: null,
      kindLabel: "Shopify chargeback", title: "", facts: [], amount: 0, due: "",
      link: "", linkLabel: "", quiet: null, missed: false, contestedSince: null,
      openedAt: "2026-09-08T00:00:00Z",
    };
    const mk = (o: Partial<Row>): Row => ({ ...base, ...o });
    const cb = (key: string, title: string, amt: number, order: string, code: string, due: string) =>
      mk({ key, title, amount: amt, due, facts: [`Order ${order}`, `Network code ${code}`],
           link: "https://admin.shopify.com/store/paymore-westport/payments/disputes",
           linkLabel: "Respond in Shopify" });

    // 0119: a card on its last chargeable day (LEE #MO01-9799, 2026-09-28) and
    // one that already ran out (WSP #MO02-6808), both real.
    const pay = (o: Partial<Row>) => mk({ type: "payment", linkLabel: "Open in Shopify",
      dueVerb: "charge the card by", missedText: "card expired", ...o });
    const cardToday = pay({ key: "p1", state: "needs_reply", kindLabel: "Card not charged yet",
      title: "Pitfall (Atari 2600, 1982)", amount: 16.26, due: addDaysIso(day, 1), facts: ["Order #MO02-7002", "1 not shipped"],
      link: "https://admin.shopify.com/store/paymore-westport/orders/1" });
    const cardGone = pay({ key: "p2", state: "due", note: "missed_window", missed: true, missedText: "",
      kindLabel: "Card expired — not collected", title: "Sony PlayStation 5 Digital", amount: 452.93,
      facts: ["Order #MO02-6808", "1 not shipped"], openedAt: "2026-08-25T00:00:00Z",
      link: "https://admin.shopify.com/store/paymore-westport/orders/2" });
    const dueToday = [
      cb("d1", "Product unacceptable", 199.99, "#MO02-6573", "13.3", day),
      cb("d2", "Product unacceptable", 120.00, "#MO02-6562", "13.3", day),
      cardToday,
    ];
    const wsp = [
      ...dueToday,
      mk({ key: "c1", type: "ebay_case", state: "needs_reply", kindLabel: "Item not received",
           title: "Nintendo Switch Joy-Cons 2 Pair Controller BEE-012 Red/Blue", amount: 74.99,
           due: addDaysIso(day, 3), facts: ["Order 27-15094-25739", "Buyer powerflowgaming"],
           openedAt: "2026-09-19T00:00:00Z" }),
      cb("d3", "Fraudulent", 331.40, "#MO02-6978", "4837", addDaysIso(day, 25)),
      mk({ key: "c2", type: "ebay_case", state: "needs_claim", kindLabel: "Refunded item not received",
           title: "Dell Latitude 5420 14\" i5-1135G7 2.4GHz 16GB RAM 256GB SSD", amount: 259.98,
           facts: ["Order 24-14843-32595", "Buyer ariz-store"], openedAt: "2026-09-02T00:00:00Z" }),
      mk({ key: "m1", type: "mismatch", state: "due", kindLabel: "Refund mismatch",
           title: "Refunded on eBay, but not on Shopify", amount: 519.99,
           facts: ["eBay order 25-15003-02000", "Shopify #MO02-6538"], openedAt: "2026-09-05T00:00:00Z" }),
      cardGone,
    ];
    const missed = [
      { ...cardGone, store: "WSP" },
      mk({ key: "x1", store: "MPL", kindLabel: "eBay payment dispute", missed: true, amount: 459.99,
           title: "Payment dispute", facts: ["Order 01-15084-49541", "Buyer did not recognise the transaction"] }),
      mk({ key: "x2", store: "BAL", type: "ebay_case", kindLabel: "eBay case", missed: true, amount: 799.99,
           title: "Asus ROG Strix Gaming PC", facts: ["Case 5384957079", "Due Sep 14"] }),
    ];
    const contested = [
      mk({ key: "y1", store: "MPL", kindLabel: "Shopify chargeback", amount: 57.00,
           title: "Product unacceptable", facts: ["Order #MO03-2699", "Joseph marked it resolved on Sep 20"],
           contestedSince: "2026-09-20T15:00:00Z" }),
    ];
    const byStore: Record<string, Row[]> = { OVL: [], LEE: [], WSP: wsp, MPL: [], BAL: [] };
    const counts: Record<string, any> = {
      BAL: { disputes: 2, inrs: 5, cases: 2, mismatch: 8, payments: 0, claims: 2, dueToday: 0 },
      MPL: { disputes: 2, inrs: 6, cases: 0, mismatch: 7, payments: 0, claims: 1, dueToday: 0 },
      WSP: { disputes: 3, inrs: 6, cases: 0, mismatch: 2, payments: 2, claims: 0, dueToday: 3 },
      LEE: { disputes: 0, inrs: 3, cases: 0, mismatch: 2, payments: 3, claims: 1, dueToday: 0 },
      OVL: { disputes: 1, inrs: 3, cases: 0, mismatch: 0, payments: 0, claims: 0, dueToday: 0 },
    };
    const html =
      kind === "manager_nudge" ? managerNudge("WSP", dueToday, day)
      : kind === "dm_due_today" ? dmDueToday({ WSP: dueToday }, day)
      : kind === "dm_digest" ? dmDigest(byStore, counts, missed, contested, day)
      : managerDaily("WSP", wsp, new Set(["dispute|d3", "ebay_case|c2", "mismatch|m1"]),
                     { returns: 6, claims: 0, quiet: 2 }, day);
    return new Response(html, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
  }
  // dry=1 builds everything and reports what it WOULD send, sending nothing and
  // logging nothing. The only safe way to look at a change to these templates:
  // a real run cannot be taken back, and writing the log would make tomorrow's
  // "new since yesterday" wrong as well.
  const dry = url.searchParams.get("dry") === "1" || url.searchParams.get("preview") === "1";
  const only = (url.searchParams.get("store") || "").toUpperCase();
  // PREVIEW returns the first mail this run would build, as a page, and sends
  // and logs nothing. These templates are otherwise unviewable without waiting
  // for a real morning — which is how the first cut of them shipped looking
  // nothing like the rest of our reports.
  const preview = url.searchParams.get("preview") === "1";
  const previews: string[] = [];
  // ?to= sends the real thing to one address instead of the real lists — the
  // only way to prove the whole pipe, relay included, without mailing five
  // stores. It deliberately does NOT write hold_email_log: a test send that
  // marked items as told would make Monday's first mail claim there was nothing
  // new, and there would be no way to undo it.
  const toOverride = (url.searchParams.get("to") || "").trim();
  const listFor = async (key: string) => toOverride ? [toOverride] : await recipients(key);
  const logIt = async (kind: string, store: string, rows: Row[], day: string) => {
    if (!toOverride) await logSent(kind, store, rows, day);
  };

  try {
    // READ FIRST — see FRESHNESS. ?nosync=1 skips it, for looking at a template.
    const syncErr = url.searchParams.get("nosync") === "1" ? null : await refresh();
    const data = await fetchState();
    const today = data.today || chicagoDay(new Date());
    const stale = staleness(data);
    const staleStores = STORES.filter((s) => stale[s]?.length);
    // The DM hears about every store; a manager only about their own.
    const dmWarn = [
      ...(syncErr ? [`All stores: ${syncErr}.`] : []),
      ...staleStores.map((s) => `${STORE_NAME[s] || s}: ${stale[s].join("; ")}.`),
    ];
    const storeWarn = (s: string) => stale[s]?.length ? [`${stale[s].join("; ")}.`] : [];
    const rows = allRows(data).filter((r) => !only || r.store === only);

    // Everything ever mailed, so "new" means new to the manager rather than new
    // to the database.
    const seenRows = await sb(`hold_email_log?select=item_type,item_key,kind,state,sent_on&kind=eq.manager_daily`,
      { headers: { Prefer: "return=representation" } }) || [];
    const seen = new Set(seenRows.map((r: any) => `${r.item_type}|${r.item_key}`));
    const mailedToday = new Set(seenRows.filter((r: any) => r.sent_on === today)
      .map((r: any) => `${r.item_type}|${r.item_key}`));

    const byStore: Record<string, Row[]> = {};
    for (const s of STORES) byStore[s] = rows.filter((r) => r.store === s && mailable(r, today));

    const sent: any[] = [];

    // ---------------- manager_daily -------------------------------------
    if (kind === "manager_daily") {
      for (const s of STORES) {
        const list = byStore[s];
        // "Nothing to say" is only true if the list is current. A stale store with
        // an empty list gets the mail anyway, because the warning IS the news.
        if (!list.length && !storeWarn(s).length) { sent.push({ store: s, skipped: "nothing to say" }); continue; }
        const extras = {
          returns: (data.cases || []).filter((c: any) => isPlainReturn(c) && c.store_code === s && c.is_open).length,
          claims: (data.claims || []).filter((c: any) => c.store === s && c.aging).length,
          quiet: rows.filter((r) => r.store === s && r.quiet && r.quiet > addDaysIso(today, 1)).length,
        };
        const html = withWarning(managerDaily(s, list, seen, extras, today), storeWarn(s));
        previews.push(html);
        const subject = `Claims & Disputes — ${STORE_NAME[s] || s}: ${list.length} need${list.length === 1 ? "s" : ""} you`;
        const to = await listFor(`claims_disputes_${s}`);
        if (!to.length) { sent.push({ store: s, skipped: "no recipients" }); continue; }
        if (dry) { sent.push({ store: s, to, subject, items: list.length, bytes: html.length }); continue; }
        const r = await relay(to.join(","), subject, html);
        if (r.ok) await logIt("manager_daily", s, list, today);
        sent.push({ store: s, to, subject, items: list.length, ...r });
      }
    }

    // ---------------- manager_nudge / dm_due_today ----------------------
    // ONE TRIGGER, TWO AUDIENCES. Both fire on "its deadline is today, it was on
    // this morning's mail, and the site still shows no answer" — the store gets
    // told so they can fix it, the DM so they can ring the store. Deriving them
    // from one set is the point: the DM must never be told about something the
    // store was not told about first.
    if (kind === "manager_nudge" || kind === "dm_due_today") {
      const dueNow: Record<string, Row[]> = {};
      for (const s of STORES) {
        dueNow[s] = byStore[s].filter((r) => dueSoon(r, today) && mailedToday.has(`${r.type}|${r.key}`));
      }
      if (kind === "manager_nudge") {
        for (const s of STORES) {
          if (!dueNow[s].length) { sent.push({ store: s, skipped: "nothing closing today" }); continue; }
          const html = withWarning(managerNudge(s, dueNow[s], today), storeWarn(s));
          previews.push(html);
          const subject = `Due today — ${dueNow[s].length} unanswered at ${STORE_NAME[s] || s}`;
          const to = await listFor(`claims_disputes_${s}`);
          if (!to.length) { sent.push({ store: s, skipped: "no recipients" }); continue; }
          if (dry) { sent.push({ store: s, to, subject, items: dueNow[s].length }); continue; }
          const r = await relay(to.join(","), subject, html);
          if (r.ok) await logIt("manager_nudge", s, dueNow[s], today);
          // The feed card is built from exactly these log rows (claims-disputes,
          // DUE_ALERT_DONE), so tell open pages now rather than at their next poll.
          if (r.ok && !toOverride) await pingFeed(s);
          sent.push({ store: s, to, subject, items: dueNow[s].length, ...r });
        }
      } else {
        const stores = STORES.filter((s) => dueNow[s].length);
        if (!stores.length && dmWarn.length) {
          // Nothing due that we can SEE — which is only reassuring if the list is
          // current. When it is not, the DM is told that instead of nothing.
          const html = withWarning(shell("Claims &amp; Disputes may be out of date",
            "Nothing shows as due today, but at least one store could not be read recently, so that may not be the whole picture.",
            "", "SPEEKSNET · Claims &amp; Disputes"), dmWarn);
          previews.push(html);
          const subject = `Claims & Disputes could not be read — ${staleStores.join(", ") || "all stores"}`;
          const to = await listFor("claims_disputes_dm");
          if (!to.length) sent.push({ skipped: "no recipients" });
          else if (dry) sent.push({ to, subject, stale: staleStores });
          else sent.push({ to, subject, stale: staleStores, ...(await relay(to.join(","), subject, html)) });
        } else if (!stores.length) {
          sent.push({ skipped: "no store has anything due today outstanding" });
        } else {
          const html = withWarning(dmDueToday(dueNow, today), dmWarn);
          previews.push(html);
          const n = stores.reduce((a, s) => a + dueNow[s].length, 0);
          const subject = `Due today, still unanswered — ${stores.join(", ")}`;
          const to = await listFor("claims_disputes_dm");
          if (!to.length) sent.push({ skipped: "no recipients" });
          else if (dry) sent.push({ to, subject, stores, items: n });
          else {
            const r = await relay(to.join(","), subject, html);
            if (r.ok) for (const s of stores) await logIt("dm_due_today", s, dueNow[s], today);
            sent.push({ to, subject, stores, items: n, ...r });
          }
        }
      }
    }

    // ---------------- dm_digest -----------------------------------------
    if (kind === "dm_digest") {
      const counts: Record<string, any> = {};
      for (const s of STORES) {
        const list = byStore[s];
        counts[s] = {
          disputes: list.filter((r) => r.type === "dispute").length,
          inrs: list.filter((r) => r.type === "ebay_case" && /item not received|refunded item|delivered after/i.test(r.kindLabel)).length,
          cases: list.filter((r) => r.type === "ebay_case" && r.kindLabel === "eBay case").length,
          mismatch: list.filter((r) => r.type === "mismatch").length,
          payments: list.filter((r) => r.type === "payment").length,
          claims: (data.claims || []).filter((c: any) => c.store === s && c.aging).length,
          dueToday: list.filter((r) => dueSoon(r, today)).length,
        };
      }
      // SHOWN ONCE, AND ONLY ONCE. There is nothing for the DM to clear on a
      // missed window (Ethan, 2026-09-23: "I don't want that to keep showing up
      // for me since I have no way to clear that"), so the log is what stops it
      // repeating every morning for the rest of the item's life.
      const toldRows = await sb(`hold_email_log?select=item_type,item_key&kind=eq.dm_digest`,
        { headers: { Prefer: "return=representation" } }) || [];
      const told = new Set(toldRows.map((r: any) => `${r.item_type}|${r.item_key}`));
      const newMissed = rows.filter((r) => r.missed && !told.has(`${r.type}|${r.key}`));
      // The contested ones DO repeat, because that one can still be put right.
      const contested = rows.filter((r) =>
        r.contestedSince && Date.now() - Date.parse(r.contestedSince) > 2 * 86400000);

      const backupWarn = await backupWarning();
      const anything = STORES.some((s) => byStore[s].length) || newMissed.length || contested.length || dmWarn.length || backupWarn.length;
      if (!anything) sent.push({ skipped: "nothing outstanding anywhere" });
      else {
        const html = withBackupWarning(withWarning(dmDigest(byStore, counts, newMissed, contested, today), dmWarn), backupWarn);
        previews.push(html);
        const subject = `Claims & Disputes — what is still with the managers`;
        const to = await listFor("claims_disputes_dm");
        if (!to.length) sent.push({ skipped: "no recipients" });
        else if (dry) sent.push({ to, subject, newMissed: newMissed.length, contested: contested.length, backupWarn });
        else {
          const r = await relay(to.join(","), subject, html);
          // Only the missed windows are logged for this mail: they are the ones
          // whose whole behaviour depends on having been said once. Logging the
          // table's contents would make every count "already seen" tomorrow.
          if (r.ok) for (const m of newMissed) await logIt("dm_digest", m.store, [m], today);
          sent.push({ to, subject, newMissed: newMissed.length, contested: contested.length, backupWarn, ...r });
        }
      }
    }

    if (preview) {
      return new Response(previews[0] || "<p>Nothing to show — this run had nothing to say.</p>",
        { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({ success: true, kind, today, dry, sent, syncErr, stale });
  } catch (e) {
    return json({ success: false, error: String(e).slice(0, 400) }, 500);
  }
});
