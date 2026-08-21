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
  "claims", "variance_aging", "deadlines", "scores", "categories",
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
  claims:         { label: "Insurance Claims",           blurb: "A claim that has gone unresolved past a week." },
  variance_aging: { label: "Variance & Aging Inventory",  blurb: "New sheets and notes, plus the reply deadlines on both." },
  deadlines:      { label: "My Deadlines",               blurb: "Store KPIs, listing goals, store goals, expense reports." },
  scores:         { label: "Scores & Audits"  ,            blurb: "A SPEEKS scorecard or a PayMore audit being submitted." },
  // Named for the queue, not the mechanism: a manager knows what "a listing
  // with no category" is and has never heard of the `other` collection.
  categories:     { label: "Listing Categories",         blurb: "Online-store listings with no category, or on a shelf that looks wrong." },
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

// The Owner (Manager) sits on BOTH sides of this category, which no other role
// does: preferred-purchases queues its requests to whoever holds the approve
// tool — them — while recycle verdicts still come back down to them like any
// other store role. STORE_REQUESTS alone would promise only the second half and
// leave every purchase request arriving under a label that denies it exists.
const OWNER_REQUESTS = {
  label: "Purchase & Recycle Requests",
  blurb: "Purchase requests waiting on your verdict, plus the DM's answer on recycle requests you sent up.",
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
    // Owner (Manager) is deliberately NOT here — they own the purchase queue, so
    // they get both directions and their own label below.
    roles: new Set(["manager"]),
    meta: { requests: STORE_REQUESTS, scores: STORE_SCORES },
  },
  {
    roles: new Set(["owner (manager)", "owner manager"]),
    meta: { requests: OWNER_REQUESTS, scores: STORE_SCORES },
  },
];

const metaFor = (c: Category, role: string) => {
  for (const o of META_OVERRIDES) if (o.roles.has(role) && o.meta[c]) return o.meta[c]!;
  return CATEGORY_META[c];
};

// THE SUB-SWITCHES INSIDE EACH CATEGORY.
//
// A category is a routing bucket; a sub is the thing a person actually thinks
// about. "Announcements & Patch Notes" is the case that forced this: a release
// mails everybody, and somebody who wants announcements but not patch notes had
// only one switch — so the way to escape patch notes was to lose announcements,
// which is the one you most want landing.
//
// `kinds` are the exact strings the source functions queue, PLUS the due-date
// slugs from collectDue. One namespace deliberately: a person does not care
// which of the two mechanisms produced a line, only what it was about.
//
// A category with no subs (or one sub) renders as a plain row — splitting a
// category that only ever emits one thing would be a switch that duplicates the
// switch above it.
//
// `roles`, when present, narrows a sub the same way CATEGORY_ROLES narrows a
// category: an ASM receives no variance at all, so showing them a "Variance
// replies" switch would be the same lie one level down.
type Sub = { key: string; label: string; blurb: string; kinds: string[]; roles?: Set<string> };

const STORE_SIDE_ROLES = ["manager", "owner (manager)", "owner manager"];

const SUBS: Record<Category, Sub[]> = {
  announcements: [
    { key: "ann",   label: "Announcements", blurb: "Posts to the board, including priority ones.",
      kinds: ["announcement", "announcement_priority"] },
    { key: "patch", label: "Patch Notes",   blurb: "What changed in a release.",
      kinds: ["patch_notes"] },
  ],
  store_messages: [],
  requests: [
    // The owner roles are here for purchase_request only — recycle and delete
    // requests still go up to the DM. Sharing one switch is right anyway: the
    // sub answers "do I want the requests that wait on me", and which kinds
    // those are is a fact about the role, not a thing to configure.
    { key: "req_in",  label: "Requests Coming In", blurb: "Purchase and recycle requests, and delete requests, waiting on a verdict.",
      kinds: ["purchase_request", "recycle_request", "claim_delete_request", "recycle_delete_request"],
      roles: new Set(["district manager", "ceo", "owner (manager)", "owner manager"]) },
    { key: "req_out", label: "Verdicts And Replies", blurb: "The DM's answer on something you sent up.",
      kinds: ["recycle_verdict", "recycle_dm_note", "recycle_reply"] },
  ],
  claims: [],
  variance_aging: [
    // The per-note kinds (variance_dm_note / variance_mgr_reply / aging_dm_note /
    // aging_store_reply) were retired 2026-08-14 in favour of the *Review slugs
    // below, which fire once at the deadline instead of once per note. They are
    // kept in these lists on purpose: an existing muted_kinds row may still name
    // one, and dropping the name would make that saved preference unreadable.
    { key: "variance", label: "Variance Replies", blurb: "New sheets, the DM's review, and the reply deadline.",
      kinds: ["variance_upload", "variance_upload_clear", "variance_dm_note", "variance_mgr_reply",
              "varianceDue", "varianceDmReview", "varianceMgrReview"],
      roles: new Set([...STORE_SIDE_ROLES, "district manager", "ceo"]) },
    { key: "aging",    label: "Aging Inventory", blurb: "New items, the DM's replies, and the review deadline.",
      kinds: ["aging_item_added", "aging_dm_note", "aging_store_reply",
              "agingDue", "agingDmReview", "agingMgrReview"] },
  ],
  deadlines: [
    { key: "kpis",     label: "Store KPIs", blurb: "Weekly and monthly entry.",
      kinds: ["kpiWeekly", "kpiMonthly"], roles: new Set(STORE_SIDE_ROLES) },
    { key: "listing",  label: "Listing Goals", blurb: "The day's buying and listing roles, and the weekly totals.",
      kinds: ["listingGoalsDaily", "listingGoalsWeek"] },
    { key: "goals",    label: "Store Goals", blurb: "The month's gross-profit target.",
      kinds: ["gpGoals"], roles: new Set(["district manager"]) },
    { key: "expenses", label: "Expense Report", blurb: "Filing the month that just closed.",
      kinds: ["expenseFile"], roles: new Set(["district manager"]) },
  ],
  scores: [
    { key: "audits",    label: "PayMore Audits", blurb: "Practice walkthroughs and the official corporate audit.",
      kinds: ["audit_practice_submitted", "audit_official_submitted"] },
    { key: "scorecard", label: "SPEEKS Scorecard", blurb: "The Online & Marketing categories being scored.",
      kinds: ["scorecard_submitted"], roles: new Set(["district manager", "ceo", "mocd"]) },
  ],
  // One reminder, one toggle. Splitting "no category" from "wrong shelf" would
  // be two switches over one weekly email — subsFor hides a single-sub split
  // for that reason.
  categories: [],
};

// The subs worth showing this role. Fewer than two is not a split worth drawing.
const subsFor = (c: Category, role: string) => {
  const list = (SUBS[c] || []).filter((x) => !x.roles || x.roles.has(role));
  return list.length > 1 ? list : [];
};

// kind/slug -> the sub-key that governs it, or null if nothing does.
const SUB_OF_KIND = new Map<string, string>();
for (const c of CATEGORIES) for (const x of SUBS[c] || []) for (const k of x.kinds) SUB_OF_KIND.set(k, x.key);

// Every sub-key that exists, so a save cannot store junk that would then be
// impossible to switch back on from the popout.
const ALL_SUB_KEYS = new Set<string>();
for (const c of CATEGORIES) for (const x of SUBS[c] || []) ALL_SUB_KEYS.add(x.key);

// A one-word tag for the card in the email, so an alert says what KIND of thing
// it is even when it carries no store. Announcements had nothing at all in that
// slot, which made them the only card with no second line.
const KIND_LABEL: Record<string, string> = {
  announcement: "Announcement", announcement_priority: "Priority Announcement",
  patch_notes: "Patch Notes", store_comment: "Store Message",
  purchase_request: "Purchase Request", recycle_request: "Recycle Request",
  claim_delete_request: "Delete Request", recycle_delete_request: "Delete Request",
  recycle_verdict: "Recycle Verdict", recycle_dm_note: "Recycle Note", recycle_reply: "Recycle Reply",
  variance_upload: "Variance", variance_upload_clear: "Variance", variance_dm_note: "Variance",
  variance_mgr_reply: "Variance",
  varianceDmReview: "Variance", varianceMgrReview: "Variance",
  aging_item_added: "Aging Inventory", aging_dm_note: "Aging Inventory", aging_store_reply: "Aging Inventory",
  agingDmReview: "Aging Inventory", agingMgrReview: "Aging Inventory",
  audit_practice_submitted: "PayMore Audit", audit_official_submitted: "PayMore Audit",
  scorecard_submitted: "SPEEKS Scorecard",
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
  // Two directions. recycle-requests sends UP to the corp queue and its
  // verdict/notes BACK DOWN to the store that asked; preferred-purchases sends
  // up to whoever holds the approve tool, which is the Owner (Manager), NOT
  // corp. So both sides appear here, under three different labels (metaFor).
  //
  // MOCD is deliberately absent here and from every category below except the
  // two open ones (Ethan, 2026-08-13). They hold none of these tools, so every
  // switch beyond announcements and store messages was one that could never
  // send them anything. ⚠️ That was only half true until 2026-08-16:
  // preferred-purchases queued purchase requests to "mocd" outright, so they
  // arrived regardless of this set — wants() reads muted_kinds, never
  // CATEGORY_ROLES, so a category absent from the popout still delivers if an
  // audience names the role. The audience is the thing to fix, and was.
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
  // The store roles that own their own storefront tidiness. Corp is out on
  // purpose: the DM lives in this panel and their queue is a standing backlog
  // across five stores, which is not news once a week.
  categories: new Set(["manager", "owner (manager)", "owner manager"]),
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

// ---------------------------------------------------------------------------
// Feature Access, server side
// ---------------------------------------------------------------------------
// Roles alone cannot answer "can this person open this tool". Feature Access
// exists precisely to hand a tool to someone outside its default roles, or take
// it away from someone inside them, and that decision lives in
// feature_overrides. A notification that ignores it mails people about work they
// cannot open, and stays silent for the people who were given it.
//
// The DEFAULT passed in is the caller's own audience_roles match, so attaching a
// feature key never widens an audience by itself — it only lets an override move
// a named person either way. Precedence is _featureOverrideFor's exactly: user
// beats role beats default.
async function loadFeatureOverrides(sb: any, keys: string[]): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  if (!keys.length) return out;
  const { data } = await sb.from("feature_overrides")
    .select("feature_key, subject_type, subject, enabled").in("feature_key", keys);
  for (const r of data || []) {
    const k = String(r.feature_key);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(r);
  }
  return out;
}

// ⚠️ Matches the role on rawRole, NOT role. `role` is the EFFECTIVE role —
// loadPeople flattens a Multi-Store Manager to "manager" and TOM to "mocd" so
// the rest of this file can reason about them uniformly — while the Feature
// Access tool writes the slug of whatever is literally in users.role. Matching
// the flattened one would silently apply every manager's override to the MSM,
// and never match a TOM's own row at all.
function featureAllows(rows: any[], person: Person, byRole: boolean): boolean {
  if (!rows.length) return byRole;
  const lc = (v: unknown) => String(v || "").toLowerCase().trim();
  const slug = lc(person.rawRole).replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
  const forUser = rows.find((r) => lc(r.subject_type) === "user" && lc(r.subject) === lc(person.name));
  if (forUser) return !!forUser.enabled;
  const forRole = rows.find((r) => lc(r.subject_type) === "role" && lc(r.subject) === slug);
  if (forRole) return !!forRole.enabled;
  return byRole;
}

// The queue's own role filter, kept in one place because the instant drain and
// the digest sweep both have to answer it identically — they read the same rows,
// and a person on digest cadence who resolved differently would get an email
// nobody else could explain.
function passesAudience(row: any, person: Person, overrides: Map<string, any[]>): boolean {
  const roles: string[] | null = row.audience_roles;
  const byRole = !roles?.length
    || roles.map((r: string) => r.toLowerCase().trim()).includes(person.role);
  const key = row.audience_feature ? String(row.audience_feature) : null;
  return key ? featureAllows(overrides.get(key) || [], person, byRole) : byRole;
}

function featureKeysIn(queue: any[]): string[] {
  return [...new Set(queue.map((r: any) => r.audience_feature).filter(Boolean).map(String))];
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

// Switched on, has an address, wants this CATEGORY, and has not muted the
// specific sub inside it. `kind` is the queued kind or the due-date slug; a
// caller with neither is asking the category question only.
function wants(p: Prefs | undefined, cat: Category, kind?: string | null): boolean {
  if (!p || !p.enabled) return false;
  if (!p.email || !EMAIL_RE.test(String(p.email))) return false;
  if (p[`cat_${cat}`] === false) return false;
  if (kind) {
    const subKey = SUB_OF_KIND.get(String(kind));
    // Absent from muted_kinds = wanted, so a sub added after somebody last saved
    // arrives switched on rather than silently muted.
    if (subKey && Array.isArray(p.muted_kinds) && p.muted_kinds.includes(subKey)) return false;
  }
  return true;
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

// A description always opens with a capital. Unlike titleCase this moves ONE
// letter, which is the normalisation any word processor performs — so it is safe
// to run over a note somebody typed in a hurry, where re-casing every word would
// not be.
//
// The first WORD, not the first character. Most of these bodies open with a
// count ("6 items past the review date", "14 units, $46.00 total"), so leading
// digits and symbols are skipped over rather than blocking the capitalise.
//
// Anchored on purpose: an unanchored /[a-z]/ would hit the first lowercase
// letter anywhere in the string, so "14 × SKU was approved" would come back as
// "14 × SKU Was approved". Anchored, a body whose first word is already a
// capital or an acronym is left exactly as it is.
const sentence = (v: string) =>
  String(v || "").replace(/^([^a-zA-Z]*)([a-z])/, (_m, pre, ch) => pre + ch.toUpperCase());

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
        ${body ? `<div style="font-size:12.5px;font-weight:500;color:${C.muted};margin-top:4px;line-height:1.5;">${esc(sentence(body))}</div>` : ""}
        ${meta ? `<div style="font-size:11px;font-weight:700;color:${C.faint};margin-top:5px;text-transform:uppercase;letter-spacing:.04em;">${esc(meta)}</div>` : ""}
      </td>
    </tr>
  </table>`;
}

// SOMEBODY WHO COVERS ONE STORE IS NEVER TOLD WHICH STORE.
//
// Everything they are mailed is about the store they work at, so "— WSP" in the
// headline and "WESTPORT" under it are the same fact they already knew, twice.
// Multi-store people are the opposite case: for the DM, the CEO and the
// multi-store manager, the store is the most useful word in the line, and an
// email that dropped it would be unreadable. So the test is coverage, not role.
const oneStore = (p: Person | null | undefined) => !!p && p.stores.length === 1;

// Escape a store name for use inside a RegExp. Cheap insurance: these come from
// a table, and one apostrophe or hyphen would otherwise change what matches.
const rxSafe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// EVERY WORD OF A HEADLINE IS CAPITALISED (Ethan's rule, stated more than once).
//
// Done HERE rather than at the nine source functions, for two reasons: the
// nine would drift the moment somebody adds a tenth, and the due-date titles
// in collectDue below would still need doing separately. One pass, applied to
// every card, and a future notification inherits it for free.
//
// A token is LEFT ALONE if it already contains an uppercase letter or a digit.
// That is what protects the things a blind capitalise would wreck: acronyms
// (KPIs, DM, SPEEKS, PayMore), store codes (LEE, WSP), case numbers, and
// version strings — "v4.12" must not become "V4.12".
//
// Only the first letter of a word moves, so a possessive survives: "today's"
// becomes "Today's", not "Today'S". Hyphenated words get both halves.
const NO_CASE_KINDS = new Set(["announcement", "announcement_priority"]);

const titleCase = (t: string, kind?: string | null) => {
  // An announcement's headline is whatever its author typed. Re-casing somebody
  // else's writing is not a house style, it is editing their post.
  if (kind && NO_CASE_KINDS.has(String(kind))) return t;
  return String(t || "").split(/(\s+)/).map((tok) => {
    if (/[A-Z0-9]/.test(tok)) return tok;              // acronym, code, number, version
    return tok.replace(/(^|-)([a-z])/g, (_m, pre, ch) => pre + ch.toUpperCase());
  }).join("");
};

// Strip a trailing "— WSP" / "— Westport" for a single-store reader. Trailing
// only: a store named mid-sentence is doing grammatical work, and cutting it
// would leave a broken line. Falls back to the original if the strip would empty
// the title, which is what happens when the store name IS the whole headline.
const cardTitle = (title: string, person: Person, kind?: string | null) => {
  let t = String(title || "");
  if (oneStore(person)) {
    for (const code of person.stores) {
      const name = STORE_NAME[code] || code;
      t = t.replace(
        new RegExp("\\s*[—–-]\\s*(?:" + rxSafe(code) + "|" + rxSafe(name) + ")\\s*$", "i"),
        "",
      );
    }
    t = t.trim() || String(title || "");
  }
  return titleCase(t, kind);
};

// The store is only worth its own line when the reader covers more than one AND
// the headline does not already say it. Due-date items are unaffected: their
// meta is "Due"/"Overdue", which the title never carries.
const storeMeta = (
  title: string, store: string | null | undefined, kind?: string | null, person?: Person,
) => {
  const tag = kind ? (KIND_LABEL[String(kind)] || "") : "";
  if (!store) return tag;               // company-wide: the tag IS the context
  if (oneStore(person)) return tag;     // they know where they work
  const code = String(store).toUpperCase();
  const name = STORE_NAME[code] || code;
  const t = String(title || "");
  // Store already in the headline: fall back to the kind tag rather than
  // printing nothing, so every card has the same second line.
  if (t.includes(code) || t.includes(name)) return tag;
  return tag ? `${tag} · ${name}` : name;
};

const FOOT_PREFS = `You're getting this because you switched on email alerts in Settings on SPEEKSNET.<br>Turn any of them off with the cog in the top bar.`;

async function sendEmail(to: string, subject: string, html: string) {
  try {
    const res = await fetch(GMAIL_RELAY, {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
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
  // `group` is the collapse axis — see collapseItems. Items sharing one render as a
  // single counted card. Absent means "always its own card".
  items: { title: string; body: string; link: string; tone: "red" | "amber" | "sage"; meta: string; key: string; group?: string }[];
};

// Fold repeats of the same thing into ONE counted card (Ethan 2026-08-14: "I don't
// want to see 20 cards of the same thing").
//
// Done HERE, at the delivery layer, rather than at each of the fifteen
// queueNotification call sites. A batch write is normal across this whole app — 20
// aging items added at once, a DM ruling on a stack of recycle lines — and fixing
// it per caller would mean finding every one, getting each right, and remembering
// the rule the next time a tool is built. One collapse covers all of them, present
// and future.
//
// RENDERING ONLY. Every original item key must survive to the ledger: they are
// deduped individually, so a key that goes unwritten comes straight back on the
// next run and mails again. That is why this returns cards while flushOutbox keeps
// iterating box.items for notify_sent.
// The collapsed card is a COUNT AND NOTHING ELSE (Ethan 2026-08-14). An earlier
// version listed the first three SKUs plus "and 17 more", which for a weekly aging
// batch is a wall of device names nobody reads — the card links into the tool, and
// that is where the list belongs. Applied to every kind, not just aging: uniform is
// easier to trust than a per-kind rule, and no batch has yet been worth naming.
function collapseItems(items: Outbox["items"]) {
  type Card = Outbox["items"][number] & { n: number };
  const out: Card[] = [];
  const at = new Map<string, number>();

  for (const it of items) {
    const g = it.group;
    if (!g) { out.push({ ...it, n: 1 }); continue; }
    const i = at.get(g);
    if (i === undefined) { at.set(g, out.length); out.push({ ...it, n: 1 }); }
    else {
      out[i].n++;
      // Loudest tone wins — one red row in a batch makes the whole card red.
      if (it.tone === "red" || (it.tone === "amber" && out[i].tone === "sage")) out[i].tone = it.tone;
    }
  }

  // n === 1 keeps its own body: a single event still says what it was.
  return out.map((c) => (c.n === 1 ? c : { ...c, body: `${c.n} items.` }));
}

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
    // Cards, not raw items: 20 aging adds are ONE card. The subject counts cards for
    // the same reason — "20 things need you" for a single batch overstated it badly.
    const cards = collapseItems(box.items);
    const first = cards[0];
    const subject = cards.length === 1
      ? `Speeks — ${first.title}`
      : `Speeks — ${cards.length} things need you`;
    const body = `
      <div style="font-size:13.5px;font-weight:600;color:${C.charcoal};margin:0 0 14px;">Hi ${esc(box.person.name.split(" ")[0] || box.person.name)},</div>
      ${cards.map((i) => itemCard(i.title, i.body, i.link, i.tone, i.meta)).join("")}`;
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
  const overrides = await loadFeatureOverrides(sb, featureKeysIn(queue));

  // Resolve every row to its recipients first, so the ledger can be checked in
  // one query instead of one per row.
  type Hit = { row: any; person: Person; key: string };
  const hits: Hit[] = [];
  const held = new Set<number>();       // rows still owed to a digest subscriber

  for (const row of queue) {
    const cat = row.category as Category;
    const stores: string[] | null = row.audience_stores;
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
        if (!passesAudience(row, person, overrides)) continue;
      }
      const p = prefs.get(person.key);
      if (!wants(p, cat, row.kind)) continue;
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
      title: cardTitle(h.row.title, h.person, h.row.kind), body: h.row.body || "", link: h.row.link || "",
      tone: h.row.priority === "high" ? "red" : "sage",
      meta: storeMeta(h.row.title, h.row.store, h.row.kind, h.person),
      key: h.key,
      // Same kind + same store = the same thing happening repeatedly, which is what
      // a batch write looks like from here. Priority rides along so a high-priority
      // row is never folded in with routine ones.
      group: `${h.row.kind}|${h.row.store ?? ""}|${h.row.priority ?? "normal"}`,
    });
  }

  const sent = await flushOutbox(sb, boxes, {
    dryRun: opts.dryRun, to: opts.to,
    // ONE header for every alert email, whatever is inside it. It used to change
    // with the count and the mode ("Something needs you" / "A few things need you"
    // / "What's outstanding"), which made four near-identical emails look like four
    // different systems in a threaded inbox. The subject already says what this one
    // is about; the header's job is to say who it is FROM.
    // Second line intentionally empty. It carried the store name, but ONLY for
    // single-store people — the very readers who do not need telling. For
    // everyone else it was already blank, so the line never earned its space.
    heading: (o) => ["SPEEKSNET Alerts", ""],
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
  // "sage" is in the union because five due entries already use it — a reply
  // window closing is news, not a deadline — and itemCard and the outbox have
  // always accepted it. The narrower type was simply wrong, and quietly: Deno
  // Deploy does not type-check, so the file ran and only `deno check` knew.
  title: string; body: string; link: string; tone: "red" | "amber" | "sage";
  for: (p: Person) => boolean;      // who owes this
  store?: string;
  // The feature_overrides key of the surface this chases, so somebody the tool
  // has been hidden from stops being nagged about it. A function where the
  // answer depends on the reader: an expense reminder is tool-expenses for the
  // DM and tool-expenses-mgr for the MSM, and a claim is the oversight tool for
  // one and the store tool for the other.
  //
  // REVOKE-ONLY, unlike the queue path. The `for` predicate above has already
  // decided who owes this, and it encodes store coverage as well as role — an
  // override cannot stand in for that, since granting somebody a tool says
  // nothing about WHICH store they answer for. So an override can take a
  // reminder away and never invent one.
  feature?: string | ((p: Person) => string | null);
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
      feature: "widget-ws-weekly-kpis",
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
        feature: "widget-ws-weekly-kpis",
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
        feature: "widget-dm-listing-goals",
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
        feature: "listing-goals-assign",
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
        feature: "tool-store-goals",
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
      feature: (p: Person) => p.isMsm ? "tool-expenses-mgr" : "tool-expenses",
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
        feature: "widget-variance-replies",
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
        title: `Insurance claims unresolved — ${STORE_NAME[store] || store}`,
        body: `${agg.n} claim${agg.n === 1 ? "" : "s"} ${agg.n === 1 ? "has" : "have"} gone more than a week without an update (longest ${days} days). Marking one "still in progress" resets its clock.`,
        link: "index.html", tone: "red",
        for: (p) => p.role === "district manager" ||
                    (["manager", "owner (manager)", "owner manager"].includes(p.role) && covers(p, store)),
        feature: (p: Person) => p.role === "district manager" ? "tool-claims-oversight" : "tool-claims-store",
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
        feature: "widget-aging-inventory",
      });
    }
  }

  // ---- "Replies are in" — BOTH tools, BOTH directions ------------------------
  // Replaces the per-note emails the two tools used to queue on every write
  // (variance_dm_note / variance_mgr_reply / aging_dm_note / aging_store_reply,
  // all removed 2026-08-14). A period carries twenty-odd flagged lines, the drain
  // runs every five minutes, and the old shape mailed a fresh batch the entire
  // time somebody worked down the list.
  //
  // These are deadline-driven instead, so the number of notes written cannot
  // change the number of emails sent — which is the whole point. Each dedupes on
  // its `period` key, so an unread one does not nag daily.
  {
    const { data: periods } = await sb.from("variance_reply_periods")
      .select("id, store, manager_due_at, dm_notes_at, dm_reviewed_at, all_clear").is("all_clear", null);

    for (const per of periods || []) {
      const store = String(per.store || "").toUpperCase();
      const { data: items } = await sb.from("variance_reply_items")
        .select("mgr_reply, dm_note, needs_reply, dm_reply_requested").eq("period_id", per.id);
      const rows = items || [];

      if (!per.dm_notes_at) {
        // STAGE 1 — the manager's explanations are in and it is the DM's turn.
        // Mirrors the site's `readyStores`: everything answered, or the window shut
        // with whatever came in.
        const owed = rows.filter((r: any) => r.needs_reply && !r.mgr_reply).length;
        const answered = rows.filter((r: any) => r.needs_reply && r.mgr_reply).length;
        const duePassed = per.manager_due_at && new Date(per.manager_due_at).getTime() <= Date.now();
        if (answered > 0 && (owed === 0 || duePassed)) {
          due.push({
            slug: "varianceDmReview", period: String(per.id) + ":s1", cat: "variance_aging", store,
            title: `Variance replies are in — ${STORE_NAME[store] || store}`,
            body: `${answered} explanation${answered === 1 ? "" : "s"} to review`
              + (owed ? `, ${owed} still outstanding.` : ` — the store is done.`),
            link: "workspace.html#vreplies", tone: "sage",
            for: (p) => ["district manager", "ceo"].includes(p.role),
            feature: "widget-variance-replies",
          });
        }
      } else {
        // STAGE 2 — the DM asked follow-up questions and that window has now shut.
        // Same clock the site uses: two days past the later of the two stamps.
        const replyDue = Math.max(
          per.manager_due_at ? new Date(per.manager_due_at).getTime() : 0,
          new Date(per.dm_notes_at).getTime(),
        ) + 2 * 86400000;
        const replied = rows.filter((r: any) => r.dm_reply_requested && r.mgr_reply).length;
        if (Date.now() >= replyDue && !per.dm_reviewed_at) {
          due.push({
            // Keyed on the window's CLOSE DATE, not the period alone. dm_reviewed_at
            // is cleared server-side whenever a newer reply lands, so a second
            // question-and-answer cycle re-opens this condition — and a period-only
            // key would have already fired, silently swallowing every later cycle.
            // The close date moves with dm_notes_at, so each cycle gets exactly one.
            slug: "varianceDmReview", period: String(per.id) + ":s2:" + fmtDate(new Date(replyDue)),
            cat: "variance_aging", store,
            title: `Variance reply window closed — ${STORE_NAME[store] || store}`,
            body: replied
              ? `${replied} repl${replied === 1 ? "y" : "ies"} came in — give them a final review.`
              : `The window closed with no replies to your notes.`,
            link: "workspace.html#vreplies", tone: replied ? "sage" : "amber",
            for: (p) => ["district manager", "ceo"].includes(p.role),
            feature: "widget-variance-replies",
          });
        }
        // The MANAGER side of the same event.
        const asked = rows.filter((r: any) => r.dm_note).length;
        if (asked > 0) {
          due.push({
            // Keyed on the period plus the DAY the DM last wrote. The day — not the
            // timestamp — is what makes this one email: a review pass updates
            // dm_notes_at once per note, so a timestamp key would be twenty keys and
            // twenty emails, the exact thing this replaced. A genuinely later pass on
            // another day is a new key and correctly notifies again.
            slug: "varianceMgrReview", period: String(per.id) + ":" + fmtDate(new Date(per.dm_notes_at)),
            cat: "variance_aging", store,
            title: `The DM reviewed your variance replies — ${STORE_NAME[store] || store}`,
            body: `${asked} line${asked === 1 ? " has" : "s have"} a note from the DM.`
              + (rows.some((r: any) => r.dm_reply_requested && !r.mgr_reply) ? " Some ask for a reply." : ""),
            link: "workspace.html#vreplies", tone: "sage",
            for: (p) => ["manager", "owner (manager)", "owner manager"].includes(p.role) && covers(p, store),
        feature: "widget-variance-replies",
          });
        }
      }
    }
  }

  {
    // Aging has no "the DM finished reviewing" stamp — the thread is per item — so
    // both sides group BY STORE and dedupe on the week, exactly like agingDue.
    const { data: items } = await sb.from("aging_items")
      .select("id, store, due_at, dm_seen_at").is("closed_at", null).eq("status", "open");
    const ids = (items || []).map((i: any) => i.id);
    const notesById = new Map<string, any[]>();
    if (ids.length) {
      const { data: notes } = await sb.from("aging_notes")
        .select("item_id, author_side, created_at").in("item_id", ids)
        .order("created_at", { ascending: true });
      for (const n of notes || []) {
        const arr = notesById.get(n.item_id) ?? [];
        arr.push(n);
        notesById.set(n.item_id, arr);
      }
    }

    const dmSide: Record<string, number> = {};
    const mgrSide: Record<string, number> = {};
    for (const it of items || []) {
      const st = String(it.store || "").toUpperCase();
      const notes = notesById.get(it.id) ?? [];
      if (!notes.length) continue;
      const last = notes[notes.length - 1];
      const windowClosed = it.due_at && new Date(it.due_at).getTime() <= Date.now();

      if (last.author_side === "store") {
        // The store replied and it is the DM's turn. Unread only — reading IS the
        // acknowledgement here (dm_seen_at), matching _agNewStoreReply on the site.
        const seen = it.dm_seen_at ? new Date(it.dm_seen_at).getTime() : 0;
        if (new Date(last.created_at).getTime() > seen && windowClosed) {
          dmSide[st] = (dmSide[st] ?? 0) + 1;
        }
      } else if (notes.some((n: any) => n.author_side === "store")) {
        // The DM has answered a store reply — a review prompt for the store, not
        // homework. A first DM note with no store reply behind it is the store's
        // homework and already covered by agingDue above, so it is skipped here.
        mgrSide[st] = (mgrSide[st] ?? 0) + 1;
      }
    }

    for (const [store, n] of Object.entries(dmSide)) {
      due.push({
        slug: "agingDmReview", period: weekStamp(t.date), cat: "variance_aging", store,
        title: `Aging inventory replies are in — ${STORE_NAME[store] || store}`,
        body: `${n} item${n === 1 ? "" : "s"} replied and waiting on your review.`,
        link: "workspace.html#aging", tone: "sage",
        for: (p) => ["district manager", "ceo"].includes(p.role),
        feature: "widget-aging-inventory",
      });
    }
    for (const [store, n] of Object.entries(mgrSide)) {
      due.push({
        slug: "agingMgrReview", period: weekStamp(t.date), cat: "variance_aging", store,
        title: `The DM replied on aging inventory — ${STORE_NAME[store] || store}`,
        body: `${n} item${n === 1 ? " has" : "s have"} a new note from the DM.`,
        link: "workspace.html#aging", tone: "sage",
        // ASMs included here and NOT on the variance twin: they work the aging
        // threads but receive no variance at all. See the category relabelling that
        // shows them "Aging Inventory" in place of "Variance & Aging Inventory".
        for: (p) => ["manager", "owner (manager)", "owner manager", "assistant manager"].includes(p.role)
          && covers(p, store),
        feature: "widget-aging-inventory",
      });
    }
  }


  // ---- Listings with no category, or on a shelf that looks wrong ----------
  // The SPEEKS Connect Categories queue. Unlike everything else in this
  // function there is no event to hang this on: a product is created in Shopify
  // with no collection and the queue notices at the next catalogue sweep, so
  // the standing state IS the news. Both queues are already scoped to listings
  // live on the online store — an unpublished product's shelf is a shelf no
  // shopper can reach, and nagging a store about it would be work for nothing.
  //
  // WEEKLY, not daily: this is a backlog, and a backlog mailed every morning is
  // a filter rule. `period` is the week stamp, so a store gets one of these a
  // week however many times the sweep runs.
  //
  // The roles here are the tool's DEFAULT roles, deliberately. `feature` below
  // is revoke-only in this path, so hiding Categories from somebody stops the
  // mail — but GRANTING it to an ASM shows them the card on the site without
  // signing them up for email they never asked for.
  {
    const CAT_ROLES = new Set(["manager", "owner (manager)", "owner manager"]);
    const [pileRes, misRes] = await Promise.all([
      sb.from("collection_proposals").select("store_code"),
      sb.from("collection_misfiled").select("store_code"),
    ]);
    const tally = (rows: any[] | null) => {
      const m: Record<string, number> = {};
      for (const r of rows || []) {
        const s = String(r.store_code || "").toUpperCase();
        m[s] = (m[s] ?? 0) + 1;
      }
      return m;
    };
    const pile = tally(pileRes.data), mis = tally(misRes.data);
    for (const store of STORES) {
      const a = pile[store] || 0, b = mis[store] || 0;
      if (!a && !b) continue;
      const bits: string[] = [];
      // The panel calls them the “Other” collection and the wrong category, so
      // this does too — an email that names things differently from the screen
      // it sends you to is one more thing to translate.
      if (a) bits.push(`${a} listing${a === 1 ? "" : "s"} in “Other”`);
      if (b) bits.push(`${b} in the wrong category`);
      due.push({
        slug: "recatQueue", period: weekStamp(t.date), cat: "categories", store,
        // Names the half that is actually there, the same way the feed card does.
        title: (a ? `Listings need a category` : `Listings in the wrong category`)
          + ` — ${STORE_NAME[store] || store}`,
        // LEADS WITH A WORD, not a number. The mailer sentence-cases the first
        // WORD of a body, skipping leading digits — so "83 listing" came out as
        // "83 Listings with no category", which reads like a typo.
        body: `On the online store: ${bits.join(" and ")}. `
          + `Open SPEEKS Connect, then Categories, to sort them.`,
        link: "operations.html#categories", tone: "amber",
        for: (p) => CAT_ROLES.has(p.role) && covers(p, store),
        feature: "ec-view-categories",
      });
    }
  }

  return due;
}

async function runDigest(sb: any, opts: { dryRun: boolean; to: string | null; onlyUser: string | null }) {
  const people = await loadPeople(sb);
  const prefs = await loadPrefs(sb);
  const due = await collectDue(sb, people);

  // Every key any due item might ask about, resolved once. The per-person form
  // has to be expanded against the real roster rather than read off the item,
  // because which key applies IS the per-person part.
  const dueKeys = new Set<string>();
  for (const d of due) {
    if (!d.feature) continue;
    if (typeof d.feature === "string") { dueKeys.add(d.feature); continue; }
    for (const p of people) { const k = d.feature(p); if (k) dueKeys.add(k); }
  }
  const dueOverrides = await loadFeatureOverrides(sb, [...dueKeys]);

  type Hit = { d: Due; person: Person; key: string };
  const hits: Hit[] = [];
  for (const d of due) {
    for (const person of people) {
      if (opts.onlyUser && person.key !== opts.onlyUser) continue;
      if (!d.for(person)) continue;
      // Revoke-only: `for` already said they owe it, so the override's only job
      // is to take it away from somebody the tool is hidden from.
      const fk = typeof d.feature === "function" ? d.feature(person) : (d.feature || null);
      if (fk && !featureAllows(dueOverrides.get(fk) || [], person, true)) continue;
      if (!wants(prefs.get(person.key), d.cat, d.slug)) continue;
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
      title: cardTitle(h.d.title, h.person), body: h.d.body, link: h.d.link, tone: h.d.tone,
      meta: h.d.tone === "red" ? "Overdue" : "Due", key: h.key,
    });
  }

  // The digest is also when anybody on 'digest' cadence gets their held EVENTS,
  // so they receive one message a day rather than two.
  const eventsForDigest = await drainHeldForDigest(sb, people, prefs, boxes, opts);

  const sent = await flushOutbox(sb, boxes, {
    dryRun: opts.dryRun, to: opts.to,
    // Counted off the COLLAPSED cards, not the raw items — otherwise the header
    // says "23 items" above a mail showing four.
    heading: (o) => {
      const n = collapseItems(o.items).length;
      return ["SPEEKSNET Alerts", `${n} item${n === 1 ? "" : "s"}`];
    },
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

  const overrides = await loadFeatureOverrides(sb, featureKeysIn(queue));

  type Hit = { row: any; person: Person; key: string };
  const hits: Hit[] = [];
  for (const row of queue) {
    const only = nameKey(row.audience_user);
    const skip = nameKey(row.exclude_user);
    const stores: string[] | null = row.audience_stores;
    for (const person of people) {
      if (opts.onlyUser && person.key !== opts.onlyUser) continue;
      const p = prefs.get(person.key);
      if (!wants(p, row.category as Category, row.kind)) continue;
      if (p!.cadence !== "digest") continue;                 // instant folk got theirs
      if (only) { if (person.key !== only) continue; }
      else {
        if (person.key === skip) continue;
        if (stores?.length && !person.stores.some((s) => stores.map((x) => x.toUpperCase()).includes(s))) continue;
        if (!passesAudience(row, person, overrides)) continue;
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
      title: cardTitle(h.row.title, h.person, h.row.kind), body: h.row.body || "", link: h.row.link || "",
      tone: "sage", meta: storeMeta(h.row.title, h.row.store, h.row.kind, h.person), key: h.key,
      // Digest subscribers get a whole day of events at once, so they are the MOST
      // exposed to a batch write — collapse matters more here than in the drain.
      group: `${h.row.kind}|${h.row.store ?? ""}|${h.row.priority ?? "normal"}`,
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
    ${itemCard(titleCase("This is what an alert looks like"), "The real ones name the thing that needs you and where it lives on the site. You can change which kinds you get, or switch them off entirely, from the cog in the top bar.", "index.html", "sage", "Example")}`;
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
      categories: categoriesFor(me.role).map((c) => ({
        key: c, ...metaFor(c, me.role),
        // Empty array = render a plain row. The page draws whatever is here, so
        // adding a sub is a change in this file only.
        subs: subsFor(c, me.role).map((x) => ({ key: x.key, label: x.label, blurb: x.blurb })),
      })),
      muted: Array.isArray(data?.muted_kinds) ? data.muted_kinds : [],
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

    // Only sub-keys this build knows about. Junk here would be un-unmutable
    // from the popout, because the popout can only draw switches it has.
    if (Array.isArray(body.muted)) {
      row.muted_kinds = body.muted
        .map((k: unknown) => String(k))
        .filter((k: string) => ALL_SUB_KEYS.has(k));
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
