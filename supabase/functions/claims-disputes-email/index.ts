// claims-disputes-email — the mail side of the Claims & Disputes tool.
//
// FOUR SENDS, ONE FUNCTION, ?kind= picks which:
//
//   manager_daily   08:20 CT  to each store's manager. Everything of theirs that
//                             needs a person, soonest deadline first.
//   manager_nudge   16:00 CT  to a store, ONLY when something closes today, it
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
const C = { ink: "#12241c", faint: "#6d8579", line: "#dde7e1", bad: "#b3261e", warn: "#8a5a00", chip: "#eef5f1" };
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

function allRows(d: any): Row[] {
  return [
    ...(d.disputes || []).map(disputeRow),
    ...(d.cases || []).filter((c: any) => !isPlainReturn(c)).map(caseRow),
    ...(d.mismatches || []).map(mismatchRow),
  ];
}

// WHAT IS ALLOWED IN A MAIL TODAY. Needing a person, and not inside its quiet
// window. quiet_until is the INR rule (Ethan, 2026-09-23: "once they are
// notified about it via email, they don't need to see it again until the day of
// needing to refund") — set by stateOf, only ever read here.
const mailable = (r: Row, today: string) => NEED.includes(r.state) && !(r.quiet && r.quiet > today);

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
function shell(title: string, sub: string, body: string, foot: string, band = C.chip, titleColor = C.ink) {
  return `<body style="margin:0;padding:18px;background:#f4f7f5;font-family:${FONT}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;margin:0 auto;background:#ffffff;border:1px solid ${C.line};border-radius:12px;">
    <tr><td style="padding:16px 14px;background:${band};border-radius:12px 12px 0 0;">
      <div style="font-size:17px;font-weight:800;color:${titleColor};">${title}</div>
      <div style="font-size:12.5px;color:${C.faint};margin-top:5px;line-height:1.6;">${sub}</div>
    </td></tr>
    ${body}
    <tr><td style="padding:12px 14px;text-align:center;color:${C.faint};font-size:10.5px;line-height:1.6;border-top:1px solid ${C.line};background:#f7faf8;border-radius:0 0 12px 12px;">${foot}</td></tr>
  </table>
</body>`;
}

const sectionRow = (label: string, color = C.faint) =>
  `<tr><td style="padding:10px 14px;border-top:1px solid ${C.line};background:#f7faf8;">
     <div style="font-size:11px;color:${color};letter-spacing:.04em;text-transform:uppercase;font-weight:700;">${esc(label)}</div>
   </td></tr>`;

function itemRow(r: Row, today: string) {
  const late = r.due && r.due < today;
  const todayDue = r.due && r.due === today;
  const dueTxt = r.missed
    ? `<span style="color:${C.bad};font-weight:700;"> · reply window shut</span>`
    : todayDue ? `<span style="color:${C.bad};font-weight:700;"> · closes today</span>`
    : late ? `<span style="color:${C.bad};font-weight:700;"> · was due ${esc(prettyDay(r.due))}</span>`
    : r.due ? `<span style="color:${C.warn};font-weight:700;"> · answer by ${esc(prettyDay(r.due))}</span>` : "";
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
  const closing = list.filter((r) => r.due && r.due === today && !r.missed).length;
  const total = list.reduce((s, r) => s + (r.amount || 0), 0);

  let body = `<tr><td style="padding:12px 14px;border-top:1px solid ${C.line};">
    <table role="presentation" width="100%"><tr>
      <td style="font-size:12px;color:${C.faint};"><b style="color:${C.ink};font-size:19px;">${list.length}</b><br>need you</td>
      <td style="font-size:12px;color:${C.faint};"><b style="color:${closing ? C.bad : C.ink};font-size:19px;">${closing}</b><br>close today</td>
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
    `${money(total)} closes today`,
    `${esc(STORE_NAME[store] || store)}. ${rows.length === 1 ? "This was" : "These were"} on your email this morning and the site still shows no response from us.`,
    body,
    `Sent at 4:00 PM only when something closes today and nothing has changed since the morning email.<br>Answer it and this stops — the next read of the site clears it by itself.`,
    "#fbeceb", C.bad,
  );
}

// ---------------------------------------------------------------------------
// 3. The DM digest
// ---------------------------------------------------------------------------
function dmDigest(byStore: Record<string, Row[]>, counts: Record<string, any>, newMissed: Row[], contested: Row[], today: string) {
  const col = (n: number, color?: string) =>
    `<td style="text-align:center;font-size:15px;font-weight:700;color:${n ? (color || C.ink) : "#c9d5cd"};">${n || "—"}</td>`;

  const head = ["Store", "Disputes", "INRs", "Cases", "Mismatch", "Claims 7d", "Due today"];
  let table = `<tr><td style="padding:14px 12px;border-top:1px solid ${C.line};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>${head.map((h, i) => `<th style="text-align:${i ? "center" : "left"};font-size:9.5px;font-weight:700;letter-spacing:.03em;color:${i === 6 ? C.bad : C.faint};text-transform:uppercase;padding-bottom:7px;border-bottom:1.5px solid ${C.ink};">${esc(h)}</th>`).join("")}</tr>`;

  let any = false;
  for (const s of STORES) {
    const c = counts[s];
    if (!c || !(c.disputes || c.inrs || c.cases || c.mismatch || c.claims || c.dueToday)) continue;
    any = true;
    table += `<tr>
      <td style="padding:11px 0;border-bottom:1px solid ${C.line};font-size:13px;font-weight:700;color:${C.ink};">${esc(s)}</td>
      ${col(c.disputes)}${col(c.inrs)}${col(c.cases)}${col(c.mismatch)}${col(c.claims, C.warn)}${col(c.dueToday, C.bad)}
    </tr>`;
  }
  table += `</table></td></tr>`;
  if (!any) table = `<tr><td style="padding:16px 14px;border-top:1px solid ${C.line};font-size:13px;color:${C.ink};">Nothing is outstanding at any store this morning.</td></tr>`;

  let body = table;
  if (newMissed.length) {
    body += sectionRow("New — worth a conversation", C.bad);
    body += newMissed.map((r) => `<tr><td style="padding:14px;border-top:1px solid ${C.line};">
      <div style="font-size:11px;color:${C.faint};letter-spacing:.04em;text-transform:uppercase;">Missed reply window</div>
      <div style="font-size:15px;font-weight:700;color:${C.ink};margin:4px 0 6px;">${esc(r.store)} — ${money(r.amount)} ${esc(r.kindLabel)}</div>
      <div style="font-size:13px;color:${C.ink};line-height:1.6;">${esc(r.facts.join(" · "))}<br>
        <span style="color:${C.faint};">The deadline passed with no response recorded from the store.</span></div>
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
          <span style="color:${C.faint};">The site still shows no response. Past the 2-day grace, so it came to you.</span></div>
      </td></tr>`;
    }).join("");
  }

  return shell(
    "What is still sitting with the managers",
    "Counts are items still needing a person to do something. Anything already answered or settled is left out.",
    body,
    `Sent on the mornings the managers are emailed, so this is what went out to them today.<br>A store with nothing outstanding is left out of the table entirely.`,
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
    `${money(total)} closes today and is still unanswered`,
    `${stores.length === 1 ? "One store has" : `${stores.length} stores have`} something whose deadline is today. ${
      stores.length === 1 ? "It was" : "They were"} on this morning's email and the site still shows no response.`,
    body,
    `Sent at 4:00 PM only when a deadline falls today and the store has not answered it.<br>Nothing here can be cleared from this email — the store has to answer on the site.`,
    "#fbeceb", C.bad,
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

    const dueToday = [
      cb("d1", "Product unacceptable", 199.99, "#MO02-6573", "13.3", day),
      cb("d2", "Product unacceptable", 120.00, "#MO02-6562", "13.3", day),
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
    ];
    const missed = [
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
      BAL: { disputes: 2, inrs: 5, cases: 2, mismatch: 8, claims: 2, dueToday: 0 },
      MPL: { disputes: 2, inrs: 6, cases: 0, mismatch: 7, claims: 1, dueToday: 0 },
      WSP: { disputes: 3, inrs: 6, cases: 0, mismatch: 2, claims: 0, dueToday: 2 },
      LEE: { disputes: 0, inrs: 3, cases: 0, mismatch: 2, claims: 1, dueToday: 0 },
      OVL: { disputes: 1, inrs: 3, cases: 0, mismatch: 0, claims: 0, dueToday: 0 },
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
    const data = await fetchState();
    const today = data.today || chicagoDay(new Date());
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
        if (!list.length) { sent.push({ store: s, skipped: "nothing to say" }); continue; }
        const extras = {
          returns: (data.cases || []).filter((c: any) => isPlainReturn(c) && c.store_code === s && c.is_open).length,
          claims: (data.claims || []).filter((c: any) => c.store === s && c.aging).length,
          quiet: rows.filter((r) => r.store === s && r.quiet && r.quiet > today).length,
        };
        const html = managerDaily(s, list, seen, extras, today);
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
        dueNow[s] = byStore[s].filter((r) =>
          r.due && r.due === today && !r.missed && mailedToday.has(`${r.type}|${r.key}`));
      }
      if (kind === "manager_nudge") {
        for (const s of STORES) {
          if (!dueNow[s].length) { sent.push({ store: s, skipped: "nothing closing today" }); continue; }
          const html = managerNudge(s, dueNow[s], today);
          previews.push(html);
          const subject = `Closes today — ${dueNow[s].length} unanswered at ${STORE_NAME[s] || s}`;
          const to = await listFor(`claims_disputes_${s}`);
          if (!to.length) { sent.push({ store: s, skipped: "no recipients" }); continue; }
          if (dry) { sent.push({ store: s, to, subject, items: dueNow[s].length }); continue; }
          const r = await relay(to.join(","), subject, html);
          if (r.ok) await logIt("manager_nudge", s, dueNow[s], today);
          sent.push({ store: s, to, subject, items: dueNow[s].length, ...r });
        }
      } else {
        const stores = STORES.filter((s) => dueNow[s].length);
        if (!stores.length) {
          sent.push({ skipped: "no store has anything due today outstanding" });
        } else {
          const html = dmDueToday(dueNow, today);
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
          claims: (data.claims || []).filter((c: any) => c.store === s && c.aging).length,
          dueToday: list.filter((r) => r.due && r.due === today && !r.missed).length,
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

      const anything = STORES.some((s) => byStore[s].length) || newMissed.length || contested.length;
      if (!anything) sent.push({ skipped: "nothing outstanding anywhere" });
      else {
        const html = dmDigest(byStore, counts, newMissed, contested, today);
        previews.push(html);
        const subject = `Claims & Disputes — what is still with the managers`;
        const to = await listFor("claims_disputes_dm");
        if (!to.length) sent.push({ skipped: "no recipients" });
        else if (dry) sent.push({ to, subject, newMissed: newMissed.length, contested: contested.length });
        else {
          const r = await relay(to.join(","), subject, html);
          // Only the missed windows are logged for this mail: they are the ones
          // whose whole behaviour depends on having been said once. Logging the
          // table's contents would make every count "already seen" tomorrow.
          if (r.ok) for (const m of newMissed) await logIt("dm_digest", m.store, [m], today);
          sent.push({ to, subject, newMissed: newMissed.length, contested: contested.length, ...r });
        }
      }
    }

    if (preview) {
      return new Response(previews[0] || "<p>Nothing to show — this run had nothing to say.</p>",
        { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({ success: true, kind, today, dry, sent });
  } catch (e) {
    return json({ success: false, error: String(e).slice(0, 400) }, 500);
  }
});
