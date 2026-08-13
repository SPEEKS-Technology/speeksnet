// ============================================================================
// SPEEKS Email Notifications  —  Supabase Edge Function
// ----------------------------------------------------------------------------
// Tells people by email that something on the site wants them. Four jobs in one
// function, because they all need the same audience-resolution and the same
// preference table:
//
//   GET   + x-user-pin                     read my settings (the cog popout)
//   POST  + x-user-pin  {action:'save'}     write my settings
//   ?secret=…&mode=drain                    every 15 min: send queued EVENTS
//   ?secret=…&mode=digest                   once at 9am CT: send DUE DATES
//
// Test flags on the two cron modes:
//   &dryRun=1     build the emails, return them, send nothing
//   &to=addr      send everything to one address instead of the real people
//   &user=name    only consider this one person
//
// ----------------------------------------------------------------------------
// WHY TWO MODES, AND NOT ONE
//
// The site's alerts divide cleanly by what causes them, and the two halves
// cannot share a mechanism:
//
//   EVENTS are writes. Something happened — an announcement was posted, a
//   request came in, a reply landed. The function that did the write knows both
//   that it happened and who cares, so it drops a notify_queue row on its way
//   out (right next to the broadcastChange it already makes). This mode just
//   delivers that queue. Adding a new event is a one-line change in the source
//   function; nothing here needs to know about it beyond its category.
//
//   DUE DATES are absences. Nothing happened, and that is precisely the alert:
//   no KPI row for the week, no goals set for today, no expense report filed.
//   There is no write to hang a queue row on, so this mode RECOMPUTES them from
//   scratch on a schedule. Each check below is the server-side twin of a
//   check*() in speeks.js.
//
// ----------------------------------------------------------------------------
// THE RULE THIS FUNCTION FOLLOWS ABOUT WHO GETS NAGGED
//
// The email must agree with the feed. Every gate here mirrors the role/store
// gate of the card it is emailing about, quirks included — see ROLE NOTES below.
// Where the site's own gate looks wrong, this function copies it anyway and the
// discrepancy gets fixed on the site side, in both places at once. An email that
// nags somebody the site never nags is worse than no email.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SECRET      = "sp33ks-sync-k3y-2026-x9mq";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";
const SITE = "https://speeksnet.com";

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
// Kept in step with MULTISTORE_MANAGER_STORES in speeks.js.
const MSM_STORES = ["BAL", "MPL"];

const STORE_NAME: Record<string, string> = {
  OVL: "Overland Park", LEE: "Lee's Summit", WSP: "Westport",
  MPL: "Maplewood", BAL: "Ballwin",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CATEGORIES = [
  "announcements", "store_messages", "requests",
  "claims", "variance_aging", "deadlines", "scores",
] as const;
type Category = typeof CATEGORIES[number];

// Popout copy. Kept here rather than in the page so the labels and the routing
// can never drift apart — the frontend renders whatever this returns.
const CATEGORY_META: Record<Category, { label: string; blurb: string }> = {
  announcements:  { label: "Announcements & Patch Notes", blurb: "New announcements, and what changed in a release." },
  store_messages: { label: "Store Messages",             blurb: "A message sent to your store by a manager, the DM or the CEO." },
  // B2B is deliberately absent from this blurb. The B2B module is being rebuilt,
  // so b2b-deals carries no notification hook and nothing in this category ever
  // comes from it — promising "B2B deals" here would be a toggle that quietly
  // does nothing. When that module lands, add its queueNotification calls and put
  // B2B back in this sentence at the same time.
  requests:       { label: "Requests Waiting On Me" ,     blurb: "Purchase requests and recycle requests." },
  claims:         { label: "Insurance Claims Aging",     blurb: "A claim that has gone unresolved past a week." },
  variance_aging: { label: "Variance & Aging Inventory",  blurb: "New sheets and notes, plus the reply deadlines on both." },
  deadlines:      { label: "My Deadlines",               blurb: "Store KPIs, listing goals, store goals, expense reports." },
  scores:         { label: "Scores & Audits"  ,            blurb: "A SPEEKS scorecard or a PayMore audit being submitted." },
};

// PER-ROLE LABEL OVERRIDES.
//
// Where the same routing genuinely delivers different things to different roles,
// the override has to exist: a label naming somebody else's half of the tool is
// worse than a generic one, because it promises things that can never arrive and
// the silence then reads as a bug.
const STORE_REQUESTS = {
  label: "My Recycle Requests",
  blurb: "The DM's verdict, notes and replies on recycle requests you sent up.",
};

const STORE_SCORES = {
  label: "My Store's Audits",
  blurb: "A PayMore audit scored on your store, practice or official.",
};

const META_OVERRIDES: { roles: Set<string>; meta: Partial<Record<Category, { label: string; blurb: string }>> }[] = [
  {
    // Assistant Managers receive strictly less than two of these labels claim:
    // no KPIs (ASM entry is switched off on the site) and no variance at all
    // (the reply cycle is the manager's — see the variance-replies hooks). So
    // their "Variance & Aging Inventory" is aging only, and their "My Deadlines"
    // is the daily listing roles only.
    roles: new Set(["assistant manager"]),
    meta: {
      requests: STORE_REQUESTS,
      variance_aging: {
        label: "Aging Inventory",
        blurb: "New items to review, the DM's notes, and the one-week reply deadline.",
      },
      deadlines: {
        label: "My Deadlines",
        blurb: "Setting the day's buying and listing roles.",
      },
      scores: STORE_SCORES,
    },
  },
  {
    // The store side of the requests tool: they get the verdict coming back DOWN
    // on something they sent up, not a queue of requests waiting on them.
    roles: new Set(["manager", "owner (manager)", "owner manager"]),
    meta: { requests: STORE_REQUESTS, scores: STORE_SCORES },
  },
];

const metaFor = (c: Category, role: string) => {
  for (const o of META_OVERRIDES) if (o.roles.has(role) && o.meta[c]) return o.meta[c]!;
  return CATEGORY_META[c];
};

// WHICH ROLES CAN ACTUALLY RECEIVE EACH CATEGORY.
// null = everybody.
//
// This exists because the popout used to show all seven toggles to all nine roles,
// and most of them were dishonest. An Employee had a "My deadlines" switch (store
// KPIs, listing goals, expense reports) and an "Insurance claims aging" switch —
// neither of which could ever send them anything, because every queued row and
// every due-date check in those categories is gated to manager-and-above. A
// setting that cannot change what arrives is worse than a missing setting: it
// reads as "you are subscribed", so the absence of email looks like a bug.
//
// These sets are DERIVED from the audienceRoles on the queueNotification calls in
// the source functions plus the `for:` predicates in collectDue below. If you widen
// or narrow an audience there, widen or narrow it here in the same commit or the
// popout starts lying again.
const CATEGORY_ROLES: Record<Category, Set<string> | null> = {
  // cms + patch-notes queue with no audience filter at all — genuinely everyone.
  announcements: null,
  // A store comment is scoped to a store; one sent to ALL is company-wide, which
  // corp roles do receive. So: everyone.
  store_messages: null,
  // Two directions: preferred-purchases and recycle-requests send UP to the corp
  // queue, and recycle-requests sends the DM's verdict/notes BACK DOWN to the
  // store that asked. So both sides appear here, under different labels (metaFor).
  // MOCD is deliberately absent here and from every category below except the
  // two open ones (Ethan, 2026-08-13). They hold none of these tools, so every
  // switch beyond announcements and store messages was one that could never
  // send them anything.
  requests: new Set([
    "district manager", "ceo",
    "manager", "owner (manager)", "owner manager", "assistant manager",
  ]),
  // _CLAIM_ALERT_ROLES + checkAgingClaimsDM. Not the CEO — see the claims block.
  claims: new Set(["manager", "owner (manager)", "owner manager", "district manager"]),
  // Managers get variance AND aging; ASMs get aging only (relabelled for them in
  // META_OVERRIDES); DM/CEO get the replies coming back up.
  variance_aging: new Set([
    "manager", "owner (manager)", "owner manager", "assistant manager",
    "district manager", "ceo",
  ]),
  // KPIs (mgr/OM only — ASM entry is off), listing goals daily (+ASM), weekly
  // goals + GP goals + expenses (DM). An ASM therefore only ever receives the
  // daily listing-roles line, which is why their blurb says exactly that.
  deadlines: new Set([
    "manager", "owner (manager)", "owner manager", "assistant manager",
    "district manager",
  ]),
  // Two directions, like requests. The SPEEKS scorecard reports UP to corp; both
  // PayMore audits report DOWN to the store that was walked, because the store is
  // who acts on a score. So the store roles are in, under their own label.
  scores: new Set([
    "district manager", "ceo",
    "manager", "owner (manager)", "owner manager", "assistant manager",
  ]),
};

// The categories worth showing THIS person, in the canonical order.
const categoriesFor = (role: string) =>
  CATEGORIES.filter((c) => {
    const allowed = CATEGORY_ROLES[c];
    return !allowed || allowed.has(role);
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const nameKey = (n: unknown) => String(n ?? "").trim().toLowerCase();
const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ============================================================================
// CENTRAL TIME
// ----------------------------------------------------------------------------
// ⚠️ The edge runtime is UTC. A naive `new Date()` used for a day boundary rolls
// over at 7pm Central, which is how the checklist reset bug happened: the
// function decided it was tomorrow while the stores were still trading. Every
// date decision in this file goes through here.
// ============================================================================
function centralParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;          // YYYY-MM-DD, Central
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date,
    ym: `${p.year}-${p.month}`,
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute),
    dow: dowMap[p.weekday] ?? 0,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

// Date-only arithmetic on YYYY-MM-DD strings, done at UTC noon so a DST shift
// can never move the result onto the neighbouring day.
const dayMs = 86400000;
const parseDate = (s: string) => new Date(`${s}T12:00:00Z`);
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => fmtDate(new Date(parseDate(s).getTime() + n * dayMs));
// The Sunday that ended the most recently COMPLETED week (today, if it's Sunday).
const lastSunday = (s: string) => addDays(s, -parseDate(s).getUTCDay());
// The Monday that starts the week containing s.
const weekMonday = (s: string) => {
  const dow = parseDate(s).getUTCDay();          // 0=Sun
  return addDays(s, dow === 0 ? -6 : 1 - dow);
};
const prettyDate = (s: string) => {
  const d = parseDate(s);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};
// Week stamp used only as a dedupe period ("at most one of these a week"). The
// week's Monday IS the identity, so that is all it needs to be — and it stays
// readable in notify_sent.dedupe_key when something needs explaining.
function weekStamp(s: string) {
  return `W${weekMonday(s)}`;
}

// ============================================================================
// PEOPLE
// ----------------------------------------------------------------------------
// ROLE NOTES — the login rewrites two roles on its way into the session, and
// every role gate on the site therefore tests the REWRITTEN value. Resolving
// audiences against the raw users.role would quietly disagree with the site:
//
//   Multi-Store Manager -> effective role 'manager', covering BOTH BAL and MPL.
//     (speeks.js stores 'manager' in speeksUserRole and flags speeksMultiStore
//     separately, so an MSM passes every 'manager' check there is. That is why
//     they get the manager reminders for two stores rather than none.)
//   TOM -> 'mocd', homed at OVL rather than CORP.
//
// 'Store' accounts are the unattended shop-floor TVs (tv.html). They are dropped
// entirely: nobody reads that inbox, and they must never be mailed.
// ============================================================================
type Person = {
  name: string; key: string;
  role: string;            // effective, lowercased
  rawRole: string;
  store: string;           // home store
  stores: string[];        // every store they answer for (MSM: two)
  isMsm: boolean;
};

async function loadPeople(sb: any): Promise<Person[]> {
  const { data } = await sb.from("users").select("name, role, store");
  const out: Person[] = [];
  for (const u of data || []) {
    const raw = String(u.role || "").toLowerCase().trim();
    if (raw === "store") continue;                       // TV boards
    let role = raw;
    let store = String(u.store || "").toUpperCase();
    let isMsm = false;
    if (role === "multi-store manager") { role = "manager"; isMsm = true; store = MSM_STORES[0]; }
    if (role === "tom") role = "mocd";
    if (role === "mocd") store = "OVL";
    out.push({
      name: String(u.name || ""), key: nameKey(u.name),
      role, rawRole: raw, store,
      stores: isMsm ? MSM_STORES.slice() : (store && store !== "ALL" && store !== "CORP" ? [store] : []),
      isMsm,
    });
  }
  return out;
}

type Prefs = {
  user_name: string; email: string | null; enabled: boolean;
  cadence: "instant" | "digest";
} & Record<string, any>;

async function loadPrefs(sb: any): Promise<Map<string, Prefs>> {
  const { data } = await sb.from("user_notify_prefs").select("*");
  const m = new Map<string, Prefs>();
  (data || []).forEach((r: any) => m.set(nameKey(r.user_name), r));
  return m;
}

// Switched on, has an address, and wants THIS category.
function wants(p: Prefs | undefined, cat: Category): boolean {
  if (!p || !p.enabled) return false;
  if (!p.email || !EMAIL_RE.test(String(p.email))) return false;
  return p[`cat_${cat}`] !== false;
}

// ============================================================================
// THE DEDUPE LEDGER
// ----------------------------------------------------------------------------
// The one thing keeping a recurring reminder from being sent every quarter hour.
// "Set Today's Listing Goals" stays true from 8:30am until the goals are
// entered, so before sending anything we ask the ledger whether this person has
// already been told about this thing, for this period. The unique index on
// dedupe_key is the real guarantee — the check is just to avoid the round trip.
// ============================================================================
async function alreadySent(sb: any, keys: string[]): Promise<Set<string>> {
  const have = new Set<string>();
  for (let i = 0; i < keys.length; i += 200) {           // keep the IN list sane
    const chunk = keys.slice(i, i + 200);
    if (!chunk.length) continue;
    const { data } = await sb.from("notify_sent").select("dedupe_key").in("dedupe_key", chunk);
    (data || []).forEach((r: any) => have.add(r.dedupe_key));
  }
  return have;
}

// ============================================================================
// EMAIL SHELL — same visual language as the weekly report (V4 airy).
// ============================================================================
const C = {
  sage: "#1f9d57", charcoal: "#1a1c1e", app: "#f1f5f2", card: "#ffffff",
  soft: "#f7faf8", line: "#eaefeb", line2: "#f4f8f5",
  muted: "#64707c", faint: "#9aa6ad", red: "#d64545", amber: "#c07f0c",
  tint: "#e8f7ee",
};

const wrapEmail = (title: string, sub: string, body: string, footer: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.app};font-family:Inter,Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.app};padding:20px 10px;"><tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden;">
  <tr><td style="background:#13181a;padding:19px 24px;">
    <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6ee7a7;">Speeks Technology</div>
    <div style="font-size:19px;font-weight:800;letter-spacing:-.02em;color:#ffffff;margin-top:2px;">${esc(title)}</div>
    ${sub ? `<div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,.66);margin-top:2px;">${esc(sub)}</div>` : ""}
  </td></tr>
  <tr><td style="height:3px;background:${C.sage};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:18px 20px;">${body}</td></tr>
  <tr><td style="padding:14px 18px;text-align:center;color:${C.faint};font-size:10.5px;border-top:1px solid ${C.line};background:${C.soft};">
    ${footer}
  </td></tr>
</table></td></tr></table></body></html>`;

// One alert. `tone` colours the left rule: red = a passed deadline, amber = owed,
// sage = news. Matches the sam-due-* classes the feed cards use.
function itemCard(title: string, body: string, link: string, tone: "red" | "amber" | "sage", meta = "") {
  const bar = tone === "red" ? C.red : tone === "amber" ? C.amber : C.sage;
  // No link. Deep links do not survive the PIN gate - an unauthenticated hit on
  // workspace.html bounces to login and lands on the dashboard, so the button
  // promised a jump it could not make. Until the login flow can carry a
  // destination, this is a reminder system: it tells you what needs you and
  // trusts you to know where that lives. `link` stays on the signature so the
  // nine calling functions need no change when it comes back.
  // The tone rule is a BORDER on the card, not a spacer cell. As a <td width="3">
  // it was a real table cell, and phone clients grow a cell to the row height
  // plus the row padding - so the bar ran past the bottom of the card on mobile
  // while looking right on desktop. A border is the card's height by definition.
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;background:${C.soft};border:1px solid ${C.line};border-left:3px solid ${bar};border-radius:13px;">
    <tr>
      <td style="padding:13px 15px;">
        <div style="font-size:14.5px;font-weight:800;color:${C.charcoal};letter-spacing:-.01em;">${esc(title)}</div>
        ${body ? `<div style="font-size:12.5px;font-weight:500;color:${C.muted};margin-top:4px;line-height:1.5;">${esc(body)}</div>` : ""}
        ${meta ? `<div style="font-size:11px;font-weight:700;color:${C.faint};margin-top:5px;text-transform:uppercase;letter-spacing:.04em;">${esc(meta)}</div>` : ""}
      </td>
    </tr>
  </table>`;
}

// The store is only worth its own line when the headline does not already say
// it. Nearly every queued title ends "- WSP", so stamping "WESTPORT" underneath
// was the same fact twice in two different spellings. Due-date items are
// unaffected: their meta is "Due"/"Overdue", which the title never carries.
const storeMeta = (title: string, store: string | null | undefined) => {
  if (!store) return "";
  const code = String(store).toUpperCase();
  const name = STORE_NAME[code] || code;
  const t = String(title || "");
  return (t.includes(code) || t.includes(name)) ? "" : name;
};

const FOOT_PREFS = `You're getting this because you switched on email alerts in Settings on SPEEKSNET.<br>Turn any of them off with the cog in the top bar.`;

async function sendEmail(to: string, subject: string, html: string) {
  try {
    const res = await fetch(GMAIL_RELAY, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SECRET, to, subject, html }),
    });
    const txt = await res.text();
    return { ok: res.ok, error: res.ok ? null : txt.slice(0, 300) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

// ============================================================================
// An assembled email, before sending. Collected per person so a burst of events
// becomes ONE message rather than six.
// ============================================================================
type Outbox = {
  person: Person; email: string;
  items: { title: string; body: string; link: string; tone: "red" | "amber" | "sage"; meta: string; key: string }[];
};

function newOutbox(map: Map<string, Outbox>, person: Person, email: string): Outbox {
  let o = map.get(person.key);
  if (!o) { o = { person, email, items: [] }; map.set(person.key, o); }
  return o;
}

async function flushOutbox(
  sb: any, boxes: Map<string, Outbox>, opts: { dryRun: boolean; to: string | null; heading: (o: Outbox) => [string, string] },
) {
  const results: any[] = [];
  for (const box of boxes.values()) {
    if (!box.items.length) continue;
    const [title, sub] = opts.heading(box);
    const first = box.items[0];
    const subject = box.items.length === 1
      ? `Speeks — ${first.title}`
      : `Speeks — ${box.items.length} things need you`;
    const body = `
      <div style="font-size:13.5px;font-weight:600;color:${C.charcoal};margin:0 0 14px;">Hi ${esc(box.person.name.split(" ")[0] || box.person.name)},</div>
      ${box.items.map((i) => itemCard(i.title, i.body, i.link, i.tone, i.meta)).join("")}`;
    const html = wrapEmail(title, sub, body, FOOT_PREFS);
    const target = opts.to || box.email;

    if (opts.dryRun) {
      results.push({ user: box.person.name, to: target, subject, items: box.items.length, html });
      continue;
    }

    const sent = await sendEmail(target, subject, html);
    // One ledger row per ITEM, not per email: each item carries its own dedupe
    // key, and they must all be marked or the un-marked ones come back next run.
    const rows = box.items.map((i) => ({
      dedupe_key: i.key, user_name: box.person.key, email: target,
      subject, status: sent.ok ? "sent" : "failed", error: sent.error,
    }));
    // ignoreDuplicates: two overlapping runs both claiming the same item is a
    // race the unique index settles. Losing the insert is the correct outcome.
    await sb.from("notify_sent").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
    results.push({ user: box.person.name, to: target, subject, items: box.items.length, ok: sent.ok, error: sent.error });
  }
  return results;
}

// ============================================================================
// MODE: DRAIN  —  queued events
// ============================================================================
async function runDrain(sb: any, opts: { dryRun: boolean; to: string | null; onlyUser: string | null }) {
  const { data: queue } = await sb.from("notify_queue")
    .select("*").is("processed_at", null).order("created_at", { ascending: true }).limit(500);
  if (!queue?.length) return { mode: "drain", queued: 0, sent: [] };

  const people = await loadPeople(sb);
  const prefs = await loadPrefs(sb);

  // Resolve every row to its recipients first, so the ledger can be checked in
  // one query instead of one per row.
  type Hit = { row: any; person: Person; key: string };
  const hits: Hit[] = [];
  const held = new Set<number>();       // rows still owed to a digest subscriber

  for (const row of queue) {
    const cat = row.category as Category;
    const stores: string[] | null = row.audience_stores;
    const roles: string[] | null = row.audience_roles;
    const only = nameKey(row.audience_user);
    const skip = nameKey(row.exclude_user);

    for (const person of people) {
      if (opts.onlyUser && person.key !== opts.onlyUser) continue;
      // A named recipient wins outright; the store/role axes don't apply.
      if (only) {
        if (person.key !== only) continue;
      } else {
        if (person.key === skip) continue;               // don't mail your own write
        if (stores?.length && !person.stores.some((s) => stores.map((x) => x.toUpperCase()).includes(s))) continue;
        if (roles?.length && !roles.map((r) => r.toLowerCase().trim()).includes(person.role)) continue;
      }
      const p = prefs.get(person.key);
      if (!wants(p, cat)) continue;
      // Somebody on the daily digest only hears about this at 9am — UNLESS it is
      // flagged high (a priority announcement), which rides the next drain for
      // everybody. Their row stays unprocessed so the digest can pick it up.
      if (p!.cadence === "digest" && row.priority !== "high") { held.add(row.id); continue; }
      hits.push({ row, person, key: `q:${row.id}:${person.key}` });
    }
  }

  const seen = await alreadySent(sb, hits.map((h) => h.key));
  const boxes = new Map<string, Outbox>();
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    const p = prefs.get(h.person.key)!;
    const box = newOutbox(boxes, h.person, String(p.email));
    box.items.push({
      title: h.row.title, body: h.row.body || "", link: h.row.link || "",
      tone: h.row.priority === "high" ? "red" : "sage",
      meta: storeMeta(h.row.title, h.row.store),
      key: h.key,
    });
  }

  const sent = await flushOutbox(sb, boxes, {
    dryRun: opts.dryRun, to: opts.to,
    // ONE header for every alert email, whatever is inside it. It used to change
    // with the count and the mode ("Something needs you" / "A few things need you"
    // / "What's outstanding"), which made four near-identical emails look like four
    // different systems in a threaded inbox. The subject already says what this one
    // is about; the header's job is to say who it is FROM.
    heading: (o) => ["SPEEKSNET Alerts",
                     o.person.stores.length === 1 ? (STORE_NAME[o.person.stores[0]] || "") : ""],
  });

  // Mark done only what nobody is still owed. A row held for a digest
  // subscriber stays open; the 48-hour backstop stops anything living forever
  // (e.g. the only digest recipient turned their email off after it was queued).
  if (!opts.dryRun) {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const done = queue
      .filter((r: any) => !held.has(r.id) || new Date(r.created_at).getTime() < cutoff)
      .map((r: any) => r.id);
    if (done.length) {
      await sb.from("notify_queue").update({ processed_at: new Date().toISOString() }).in("id", done);
    }
    try { await sb.rpc("notify_prune"); } catch (_) { /* housekeeping only */ }
  }

  return { mode: "drain", queued: queue.length, held: held.size, sent };
}

// ============================================================================
// MODE: DIGEST  —  due dates, recomputed
// ----------------------------------------------------------------------------
// Each block below mirrors one check*() in speeks.js. The gate comments name the
// constant being copied so the two can be kept honest against each other.
// ============================================================================
type Due = {
  slug: string; period: string; cat: Category;
  title: string; body: string; link: string; tone: "red" | "amber";
  for: (p: Person) => boolean;      // who owes this
  store?: string;
};

async function collectDue(sb: any, people: Person[]): Promise<Due[]> {
  const t = centralParts();
  const due: Due[] = [];

  // Which stores each person answers for, as a test helper.
  const covers = (p: Person, store: string) => p.stores.includes(store);

  // ---- Store KPIs, weekly + monthly -------------------------------------
  // Gate: _KPI_DUE_ROLES = manager / owner (manager) / owner manager. Assistant
  // Managers are deliberately NOT included (ASM KPI entry is switched off; the
  // comment at speeks.js:5513 says to add them here when it comes back). An MSM
  // reaches this as 'manager' and therefore owes both stores.
  const KPI_ROLES = new Set(["manager", "owner (manager)", "owner manager"]);
  const wkEnd = lastSunday(t.date);
  const { data: wkRows } = await sb.from("kpi_entries")
    .select("store").eq("period_type", "weekly").eq("period_end_date", wkEnd);
  const wkHave = new Set((wkRows || []).map((r: any) => String(r.store).toUpperCase()));
  // Overdue once the Monday 08:30 CT deadline after the reporting Sunday passes.
  const wkOverdue = t.date > addDays(wkEnd, 1) || (t.date === addDays(wkEnd, 1) && t.minutes >= 8 * 60 + 30);
  for (const store of STORES) {
    if (wkHave.has(store)) continue;
    due.push({
      slug: "kpiWeekly", period: wkEnd, cat: "deadlines", store,
      title: wkOverdue ? `Weekly KPIs overdue — ${STORE_NAME[store]}` : `Weekly KPIs due — ${STORE_NAME[store]}`,
      body: `Nothing has been entered for the week ending ${prettyDate(wkEnd)}.${wkOverdue ? " The Monday 8:30am deadline has passed." : ""}`,
      link: "workspace.html#kpis", tone: wkOverdue ? "red" : "amber",
      for: (p) => KPI_ROLES.has(p.role) && covers(p, store),
    });
  }

  // Monthly: the month that just closed, chased from the first Sunday after it
  // ended (_kpiFirstSundayAfter) — before that it isn't late, it isn't even open.
  const lastMonth = (() => {
    const d = new Date(Date.UTC(t.year, t.month - 2, 1));  // month is 1-based
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  })();
  const monthEnd = fmtDate(new Date(Date.UTC(t.year, t.month - 1, 0)));
  const firstSunAfter = addDays(monthEnd, (7 - parseDate(monthEnd).getUTCDay()) % 7 || 7);
  if (t.date >= firstSunAfter) {
    const { data: moRows } = await sb.from("kpi_entries")
      .select("store").eq("period_type", "monthly").eq("year", lastMonth.y).eq("month", lastMonth.m);
    const moHave = new Set((moRows || []).map((r: any) => String(r.store).toUpperCase()));
    const moOverdue = t.date > addDays(firstSunAfter, 1);
    const label = new Date(Date.UTC(lastMonth.y, lastMonth.m - 1, 1))
      .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    for (const store of STORES) {
      if (moHave.has(store)) continue;
      due.push({
        slug: "kpiMonthly", period: `${lastMonth.y}-${String(lastMonth.m).padStart(2, "0")}`,
        cat: "deadlines", store,
        title: moOverdue ? `Monthly KPIs overdue — ${STORE_NAME[store]}` : `Monthly KPIs due — ${STORE_NAME[store]}`,
        body: `${label} has closed and no monthly KPIs have been entered.`,
        link: "workspace.html#kpis", tone: moOverdue ? "red" : "amber",
        for: (p) => KPI_ROLES.has(p.role) && covers(p, store),
      });
    }
  }

  // ---- Listing goals: the DM's weekly totals -----------------------------
  // Gate: checkListingGoalReminders — District Manager only ("the CEO reads the
  // result but does not set it"). Due 8am Monday store time; the card then stays
  // up all week until every store is set, so this does too.
  const monday = weekMonday(t.date);
  if (!(t.dow === 1 && t.hour < 8)) {
    const { data: wkGoals } = await sb.from("listing_goal_weeks").select("store").eq("week_start", monday);
    const set = new Set((wkGoals || []).map((r: any) => String(r.store).toUpperCase()));
    const missing = STORES.filter((s) => !set.has(s));
    if (missing.length) {
      due.push({
        slug: "listingGoalsWeek", period: monday, cat: "deadlines",
        title: "Set this week's listing goals",
        body: `${missing.length} store${missing.length === 1 ? "" : "s"} still have no weekly total: ${missing.join(", ")}. Every listing goal bar has nothing to measure against until they're set.`,
        link: "index.html", tone: "amber",
        for: (p) => p.role === "district manager",
      });
    }
  }

  // ---- Listing goals: today's roles, per store ---------------------------
  // Gate: _LG_DAILY_ROLES = manager / owner (manager) / owner manager /
  // assistant manager / multi-store manager. Stores are closed Sunday, and the
  // card only appears from 8:30am — so neither does this.
  if (t.dow !== 0 && t.minutes >= 8 * 60 + 30) {
    const LG_ROLES = new Set(["manager", "owner (manager)", "owner manager", "assistant manager"]);
    const { data: today } = await sb.from("listing_goals").select("store").eq("date", t.date);
    const set = new Set((today || []).map((r: any) => String(r.store).toUpperCase()));
    for (const store of STORES) {
      if (set.has(store)) continue;
      due.push({
        slug: "listingGoalsDaily", period: t.date, cat: "deadlines", store,
        title: `Set today's listing goals — ${STORE_NAME[store]}`,
        body: "Nobody has been given a buying or listing role today. Whoever sets them clears this for the whole store.",
        // Amber, not red. The meta label is DERIVED from the tone, so red rendered
        // this as "Overdue" from 8:31am onward - but nothing has been missed at
        // 8:31, the day's roles are simply owed. Red is for a passed deadline.
        link: "index.html", tone: "amber",
        for: (p) => LG_ROLES.has(p.role) && covers(p, store),
      });
    }
  }

  // ---- Store GP goals ----------------------------------------------------
  // Gate: _gpCanEdit defaults to District Manager. ⚠️ On the site that gate is
  // ALSO overridable per person via the Feature Access tool
  // (_featureOverrideFor('tool-store-goals')); this copies the default only, so
  // somebody granted the tool by an override sees the card but gets no email.
  // Reading feature_overrides here would fix it if that ever matters.
  {
    const { data: goals } = await sb.from("monthly_gp_goals").select("store").eq("ym", t.ym);
    const set = new Set((goals || []).map((r: any) => String(r.store).toUpperCase()));
    const missing = STORES.filter((s) => !set.has(s));
    if (missing.length) {
      due.push({
        slug: "gpGoals", period: t.ym, cat: "deadlines",
        title: "Monthly store goals need setting",
        body: `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no gross-profit goal for this month yet.`,
        link: "index.html", tone: "amber",
        for: (p) => p.role === "district manager",
      });
    }
  }

  // ---- Expense report ----------------------------------------------------
  // Gate: _EXP_REMIND_ROLES plus any MSM. The month being chased is the one that
  // just CLOSED — you file August in September (_expRemindMonth).
  {
    const filedMonth = fmtDate(new Date(Date.UTC(t.year, t.month - 2, 1)));
    const { data: filed } = await sb.from("expense_submissions").select("person").eq("month_start", filedMonth);
    const done = new Set((filed || []).map((r: any) => nameKey(r.person)));
    const label = parseDate(filedMonth).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    due.push({
      slug: "expenseFile", period: filedMonth, cat: "deadlines",
      title: "File your expense report",
      body: `${label} has closed and your expense report hasn't been marked filed.`,
      link: "index.html", tone: "amber",
      for: (p) => (p.role === "district manager" || p.isMsm) && !done.has(p.key),
    });
  }

  // ---- Variance replies due ---------------------------------------------
  // Gate: _VR_MANAGER_ROLES = manager / owner (manager) / owner manager. One
  // email per uploaded PERIOD (the dedupe period is the period id), so a fresh
  // upload notifies again but an unanswered one doesn't nag daily.
  {
    const { data: periods } = await sb.from("variance_reply_periods")
      .select("id, store, manager_due_at, all_clear").is("all_clear", null);
    for (const per of periods || []) {
      const { data: items } = await sb.from("variance_reply_items")
        .select("id").eq("period_id", per.id).eq("needs_reply", true).is("mgr_reply", null);
      if (!items?.length) continue;
      const store = String(per.store || "").toUpperCase();
      const dueAt = per.manager_due_at ? new Date(per.manager_due_at) : null;
      const late = !!dueAt && dueAt.getTime() < Date.now();
      due.push({
        slug: "varianceDue", period: String(per.id), cat: "variance_aging", store,
        title: late ? `Variance replies overdue — ${STORE_NAME[store]}` : `Variance replies due — ${STORE_NAME[store]}`,
        body: `${items.length} item${items.length === 1 ? "" : "s"} still need a reply${dueAt ? `, due ${prettyDate(fmtDate(dueAt))}` : ""}.`,
        link: "workspace.html#vreplies", tone: late ? "red" : "amber",
        for: (p) => ["manager", "owner (manager)", "owner manager"].includes(p.role) && covers(p, store),
      });
    }
  }

  // ---- Insurance claims aging -------------------------------------------
  // This one looks like an event and isn't. A claim being FILED is a write, but
  // the alert is "this claim has sat for a week untouched" — which becomes true on
  // its own, with nothing happening. So it is computed here rather than queued by
  // shopify-claims, and that function has no notification hook at all.
  //
  // ⚠️ THREE THINGS THIS HAS TO GET RIGHT, and all three are easy to get wrong.
  // The predicate is _isClaimAging in speeks.js; anything looser mails people
  // about claims they have already dealt with:
  //
  //   1. status === 'in_progress', NOT `resolved_at is null`. They are not the
  //      same set — a claim can reach a terminal status without a resolved_at.
  //   2. The clock runs from last_checked_at ?? created_at, NOT created_at.
  //      Hitting "Still in progress" in the tool stamps last_checked_at and
  //      RESTARTS the week. Measuring from created_at would ignore that review
  //      entirely and nag forever about a claim somebody checks every few days —
  //      it would actively punish using the tool properly.
  //   3. A claim escalated to an INR child is no longer open itself; the child
  //      is. Any id appearing as another row's parent_id is therefore suppressed,
  //      the same exclusion the oversight table makes. Note `sup` is built from
  //      EVERY row, not just the in-progress ones, because the parent can have
  //      moved on while the child has not.
  //
  // Gate: _CLAIM_ALERT_ROLES (manager / owner (manager) / owner manager) for their
  // own store(s), plus the District Manager across all stores via
  // checkAgingClaimsDM. The CEO is deliberately NOT included — neither site check
  // covers them. Deduped weekly: the pile does not change day to day.
  //
  // KNOWN GAP vs the site, accepted: checkAgingClaimsDM also hides a store the DM
  // has already nudged (an unacknowledged reminder inside its cooldown), on the
  // grounds that it is the manager's court now. That is not reproduced here, so a
  // DM may get one weekly line about a store they have just nudged. Reproducing it
  // needs the reminders table and the cooldown; at weekly cadence it is not worth
  // the coupling.
  {
    const cutoff = Date.now() - 7 * 86400000;
    const { data: claims } = await sb.from("shopify_claims")
      .select("id, store, status, created_at, last_checked_at, parent_id");
    const sup = new Set((claims || []).filter((r: any) => r.parent_id).map((r: any) => String(r.parent_id)));
    const effective = (r: any) => new Date(r.last_checked_at || r.created_at).getTime();
    const byStore: Record<string, { n: number; oldest: number }> = {};
    for (const c of claims || []) {
      if (c.status !== "in_progress") continue;
      if (sup.has(String(c.id))) continue;
      const eff = effective(c);
      if (!isFinite(eff) || eff >= cutoff) continue;
      const s = String(c.store || "").toUpperCase();
      if (!byStore[s]) byStore[s] = { n: 0, oldest: eff };
      byStore[s].n++;
      if (eff < byStore[s].oldest) byStore[s].oldest = eff;
    }
    for (const [store, agg] of Object.entries(byStore)) {
      const days = Math.floor((Date.now() - agg.oldest) / 86400000);
      due.push({
        slug: "claimsAging", period: weekStamp(t.date), cat: "claims", store,
        title: `Insurance claims aging — ${STORE_NAME[store] || store}`,
        body: `${agg.n} claim${agg.n === 1 ? "" : "s"} ${agg.n === 1 ? "has" : "have"} gone more than a week without an update (longest ${days} days). Marking one "still in progress" resets its clock.`,
        link: "index.html", tone: "red",
        for: (p) => p.role === "district manager" ||
                    (["manager", "owner (manager)", "owner manager"].includes(p.role) && covers(p, store)),
      });
    }
  }

  // ---- Aging inventory review -------------------------------------------
  // Gate: _AG_STORE_ROLES = manager / owner (manager) / owner manager /
  // assistant manager. Deduped by WEEK, not by day: the site's card is a daily
  // snoozeable nag, but a daily email about the same open pile is noise.
  {
    const { data: items } = await sb.from("aging_items")
      .select("store, due_at").is("closed_at", null).not("due_at", "is", null);
    // Shaped like varianceDue above: every open item with a clock counts, and the
    // store is told it is OWED before it is told it is LATE. The old version only
    // ever counted items already past their date, so the first the store heard of
    // an item was the week AFTER it should have replied - which is exactly the
    // reminder that arrives too late to be worth sending.
    const nowMs = Date.now();
    const byStore: Record<string, { n: number; late: number; soonest: string }> = {};
    for (const it of items || []) {
      const s = String(it.store || "").toUpperCase();
      const d = fmtDate(new Date(it.due_at));
      if (!byStore[s]) byStore[s] = { n: 0, late: 0, soonest: d };
      byStore[s].n++;
      if (new Date(it.due_at).getTime() < nowMs) byStore[s].late++;
      if (d < byStore[s].soonest) byStore[s].soonest = d;
    }
    for (const [store, agg] of Object.entries(byStore)) {
      // One item past its date makes the whole line late, the same way a single
      // unanswered variance row does. Half-late is late.
      const late = agg.late > 0;
      due.push({
        slug: "agingDue", period: weekStamp(t.date), cat: "variance_aging", store,
        title: late
          ? `Aging inventory replies overdue — ${STORE_NAME[store] || store}`
          : `Aging inventory replies due — ${STORE_NAME[store] || store}`,
        body: late
          ? `${agg.late} item${agg.late === 1 ? "" : "s"} past the review date (oldest ${prettyDate(agg.soonest)}).`
          : `${agg.n} item${agg.n === 1 ? "" : "s"} still need a reply, due ${prettyDate(agg.soonest)}.`,
        link: "workspace.html#aging", tone: late ? "red" : "amber",
        for: (p) => ["manager", "owner (manager)", "owner manager", "assistant manager"].includes(p.role) && covers(p, store),
      });
    }
  }

  return due;
}

async function runDigest(sb: any, opts: { dryRun: boolean; to: string | null; onlyUser: string | null }) {
  const people = await loadPeople(sb);
  const prefs = await loadPrefs(sb);
  const due = await collectDue(sb, people);

  type Hit = { d: Due; person: Person; key: string };
  const hits: Hit[] = [];
  for (const d of due) {
    for (const person of people) {
      if (opts.onlyUser && person.key !== opts.onlyUser) continue;
      if (!d.for(person)) continue;
      if (!wants(prefs.get(person.key), d.cat)) continue;
      hits.push({ d, person, key: `due:${d.slug}:${d.period}:${person.key}` });
    }
  }

  const seen = await alreadySent(sb, hits.map((h) => h.key));
  const boxes = new Map<string, Outbox>();
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    const p = prefs.get(h.person.key)!;
    const box = newOutbox(boxes, h.person, String(p.email));
    box.items.push({
      title: h.d.title, body: h.d.body, link: h.d.link, tone: h.d.tone,
      meta: h.d.tone === "red" ? "Overdue" : "Due", key: h.key,
    });
  }

  // The digest is also when anybody on 'digest' cadence gets their held EVENTS,
  // so they receive one message a day rather than two.
  const eventsForDigest = await drainHeldForDigest(sb, people, prefs, boxes, opts);

  const sent = await flushOutbox(sb, boxes, {
    dryRun: opts.dryRun, to: opts.to,
    heading: (o) => ["SPEEKSNET Alerts", `${o.items.length} item${o.items.length === 1 ? "" : "s"}`],
  });
  if (!opts.dryRun) { try { await sb.rpc("notify_prune"); } catch (_) { /* housekeeping only */ } }
  return { mode: "digest", due: due.length, heldEvents: eventsForDigest, sent };
}

// Held queue rows for digest-cadence people, folded into the same email.
async function drainHeldForDigest(
  sb: any, people: Person[], prefs: Map<string, Prefs>, boxes: Map<string, Outbox>,
  opts: { onlyUser: string | null; dryRun: boolean },
) {
  const { data: queue } = await sb.from("notify_queue")
    .select("*").is("processed_at", null).order("created_at", { ascending: true }).limit(500);
  if (!queue?.length) return 0;

  type Hit = { row: any; person: Person; key: string };
  const hits: Hit[] = [];
  for (const row of queue) {
    const only = nameKey(row.audience_user);
    const skip = nameKey(row.exclude_user);
    const stores: string[] | null = row.audience_stores;
    const roles: string[] | null = row.audience_roles;
    for (const person of people) {
      if (opts.onlyUser && person.key !== opts.onlyUser) continue;
      const p = prefs.get(person.key);
      if (!wants(p, row.category as Category)) continue;
      if (p!.cadence !== "digest") continue;                 // instant folk got theirs
      if (only) { if (person.key !== only) continue; }
      else {
        if (person.key === skip) continue;
        if (stores?.length && !person.stores.some((s) => stores.map((x) => x.toUpperCase()).includes(s))) continue;
        if (roles?.length && !roles.map((r) => r.toLowerCase().trim()).includes(person.role)) continue;
      }
      hits.push({ row, person, key: `q:${row.id}:${person.key}` });
    }
  }

  const seen = await alreadySent(sb, hits.map((h) => h.key));
  let n = 0;
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    const p = prefs.get(h.person.key)!;
    const box = newOutbox(boxes, h.person, String(p.email));
    box.items.push({
      title: h.row.title, body: h.row.body || "", link: h.row.link || "",
      tone: "sage", meta: storeMeta(h.row.title, h.row.store), key: h.key,
    });
    n++;
  }
  // Every remaining recipient has now been served, so these rows are finished.
  if (!opts.dryRun && queue.length) {
    await sb.from("notify_queue").update({ processed_at: new Date().toISOString() })
      .in("id", queue.map((r: any) => r.id));
  }
  return n;
}

// ============================================================================
// SETTINGS (the cog popout)
// ============================================================================
async function whoAmI(sb: any, pin: string) {
  const { data } = await sb.from("users").select("name, role, store").eq("pin", pin).single();
  if (!data) return null;
  const raw = String(data.role || "").toLowerCase().trim();
  if (raw === "store") return null;             // TV board: no settings, no mail
  // Normalised the same way loadPeople does it, and for the same reason: a
  // Multi-Store Manager signs in AS a manager, so the categories they can receive
  // are a manager's. Filtering on the raw role would show them the wrong list.
  let role = raw;
  if (role === "multi-store manager") role = "manager";
  if (role === "tom") role = "mocd";
  return { name: String(data.name || ""), key: nameKey(data.name), role, rawRole: raw };
}

const DEFAULT_PREFS = () => ({
  email: null, enabled: false, cadence: "instant",
  ...Object.fromEntries(CATEGORIES.map((c) => [`cat_${c}`, true])),
});

// A confirmation the moment somebody saves an address, which doubles as the only
// proof the address WORKS. Without it a typo is silent forever: they'd switch
// alerts on, believe they're subscribed, and simply never hear anything.
async function sendWelcome(sb: any, person: { name: string; key: string }, email: string) {
  const key = `welcome:${person.key}:${email.toLowerCase()}`;
  const have = await alreadySent(sb, [key]);
  if (have.has(key)) return { skipped: true };
  const body = `
    <div style="font-size:13.5px;font-weight:600;color:${C.charcoal};margin:0 0 12px;">Hi ${esc(person.name.split(" ")[0] || person.name)},</div>
    <div style="font-size:13px;color:${C.muted};line-height:1.6;">Email alerts are on for this address. You'll hear from SPEEKSNET when something on the site needs you — and nothing else.</div>
    ${itemCard("This is what an alert looks like", "The real ones link straight to the tool that needs you. You can change which kinds you get, or switch them off entirely, from the cog in the top bar.", "index.html", "sage", "Example")}`;
  const sent = await sendEmail(email, "Speeks — email alerts are on", wrapEmail("Email alerts are on", "", body, FOOT_PREFS));
  await sb.from("notify_sent").upsert([{
    dedupe_key: key, user_name: person.key, email,
    subject: "Speeks — email alerts are on",
    status: sent.ok ? "sent" : "failed", error: sent.error,
  }], { onConflict: "dedupe_key", ignoreDuplicates: true });
  return { ok: sent.ok, error: sent.error };
}

// ============================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  const mode = q("mode");

  // ---- cron modes (secret-gated) ----
  if (mode === "drain" || mode === "digest") {
    if (q("secret") !== SECRET) return json({ error: "Unauthorized" }, 401);
    const opts = {
      dryRun: q("dryRun") === "1",
      to: q("to"),
      onlyUser: q("user") ? nameKey(q("user")) : null,
    };
    try {
      const out = mode === "drain" ? await runDrain(sb, opts) : await runDigest(sb, opts);
      return json({ success: true, ...out });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ---- my settings ----
  const pin = req.headers.get("x-user-pin") || "";

  // ---- the roster (DM/CEO): who is actually set up to be emailed ----
  // Read-only, and deliberately so. The DM needs to see who WON'T hear anything —
  // a typo'd address or an untouched switch is invisible otherwise, and the person
  // affected has no way to know they're missing mail. Editing somebody else's
  // address is not offered: it's their inbox, and the confirmation send is the
  // only real proof an address works.
  if (mode === "roster") {
    if (!pin) return json({ error: "Missing x-user-pin header" }, 401);
    const me = await whoAmI(sb, pin);
    if (!me) return json({ error: "Invalid PIN" }, 401);
    if (!["district manager", "ceo"].includes(me.role)) return json({ error: "Insufficient role" }, 403);
    const prefs = await loadPrefs(sb);
    const people = await loadPeople(sb);
    return json({
      success: true,
      roster: people.map((p) => {
        const pr = prefs.get(p.key);
        return {
          name: p.name,
          enabled: !!(pr && pr.enabled),
          hasEmail: !!(pr && pr.email && EMAIL_RE.test(String(pr.email))),
          email: pr?.email || null,
          cadence: pr?.cadence || null,
        };
      }),
    });
  }

  if (req.method === "GET") {
    if (!pin) return json({ error: "Missing x-user-pin header" }, 401);
    const me = await whoAmI(sb, pin);
    if (!me) return json({ error: "Invalid PIN" }, 401);
    const { data } = await sb.from("user_notify_prefs").select("*").eq("user_name", me.key).maybeSingle();
    return json({
      success: true,
      me: { name: me.name, role: me.role },
      prefs: data || { user_name: me.key, ...DEFAULT_PREFS() },
      // Only the categories this role can actually be sent — see CATEGORY_ROLES.
      // The stored row still carries all seven cat_* flags; the ones not shown are
      // simply never consulted for this person, so promoting somebody (Employee ->
      // ASM) reveals the extra switches already at their default rather than
      // needing a backfill.
      categories: categoriesFor(me.role).map((c) => ({ key: c, ...metaFor(c, me.role) })),
    });
  }

  if (req.method === "POST") {
    if (!pin) return json({ error: "Missing x-user-pin header" }, 401);
    const me = await whoAmI(sb, pin);
    if (!me) return json({ error: "Invalid PIN" }, 401);

    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (body.action !== "save") return json({ error: "Unknown action" }, 400);

    const email = String(body.email ?? "").trim().toLowerCase();
    const enabled = !!body.enabled;
    // An address is required to switch on, and validated whenever one is given —
    // an unsendable address saved silently is the whole failure mode here.
    if (email && !EMAIL_RE.test(email)) return json({ error: "That doesn't look like an email address." }, 400);
    if (enabled && !email) return json({ error: "Add an email address to turn alerts on." }, 400);

    const cadence = body.cadence === "digest" ? "digest" : "instant";
    const cats = (body.categories && typeof body.categories === "object") ? body.categories : {};
    const row: Record<string, any> = {
      user_name: me.key, email: email || null, enabled, cadence,
      updated_at: new Date().toISOString(),
    };
    // Only touch the categories the client actually sent. The popout shows this
    // role a SUBSET (see categoriesFor), so a blanket `cats[c] !== false` would
    // silently rewrite every hidden flag to true on each save — quietly discarding
    // a choice somebody made while they held a role that could see it. An ASM who
    // switched "My deadlines" off, moved to Employee, then came back would find it
    // back on with no idea why. Absent key = leave the stored value alone.
    const { data: existing } = await sb.from("user_notify_prefs")
      .select("*").eq("user_name", me.key).maybeSingle();
    for (const c of CATEGORIES) {
      const key = `cat_${c}`;
      if (Object.prototype.hasOwnProperty.call(cats, c)) row[key] = cats[c] !== false;
      else if (existing && existing[key] !== undefined && existing[key] !== null) row[key] = existing[key];
      // else: leave it out entirely and let the column default (true) apply.
    }

    const { error } = await sb.from("user_notify_prefs").upsert(row, { onConflict: "user_name" });
    if (error) return json({ error: error.message }, 500);

    // The confirmation is fired but NOT awaited. The Gmail relay is an Apps
    // Script web app and a cold one can take the better part of ten seconds to
    // answer — which the user experienced as a Save button that hung, because
    // the row was already written and we were sitting on an email nobody was
    // waiting for. The write is what has to be durable; the send is best-effort
    // and self-deduping (the ledger key is welcome:<user>:<address>), so
    // letting it finish after the response costs nothing and returns the save
    // in the time the database takes.
    if (enabled && email) {
      const p = sendWelcome(sb, me, email).catch(() => {});
      // Keep the isolate alive until it lands, without holding the response.
      if (typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
        (globalThis as any).EdgeRuntime.waitUntil(p);
      }
    }
    return json({ success: true, welcome: enabled && email ? { queued: true } : null });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
