import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// STORE SNAPSHOT — the QuickPortal's read of the Day End report, cash and NP.
// ----------------------------------------------------------------------------
// Ethan, 2026-10-29: "create new widgets based on aspects of the site we track
// that we not have had a dedicated widget for". Most of those live in
// day_end_facts, which until now only the morning jobs read (daily-brief,
// district-watch, processed-report). This is the browser's one door to it.
//
// READ ONLY. GET with x-user-pin. Nothing here writes, and nothing calls eBay,
// Shopify or Gmail — it is three or four small table reads.
//
// WHO SEES WHAT (the person behind the PIN, as every PIN-gated read here):
//   DM / CEO / MOCD (or store CORP)  all five stores
//   Multi-Store Manager              BAL and MPL
//   everyone else                    their own store
//   cash                             managers and up only — not ASMs below
//                                    owner level, employees or the store login
//   team production                  an employee gets only their own line
//   usage (who signed in)            DM / CEO / MOCD only
// A TEST ACCOUNT (test_users, migration 0160) reads with its own role, like the
// other seven PIN-gated reads.
//
// ?days=N (default 45, max 120): how far back the Day End rows go. Cash is the
// last 14 days; NP is this month and last (Goal Pace needs both).
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const MULTISTORE_MANAGER_STORES = ["BAL", "MPL"];
const DISTRICT_ROLES = new Set(["district manager", "ceo", "mocd"]);
const CASH_ROLES = new Set(["district manager", "ceo", "mocd", "manager", "owner (manager)", "multi-store manager"]);
const FACT_COLS = [
  "store", "date", "est_value", "total_spent", "est_margin_pct", "cust_conv_num", "cust_conv_den",
  "failed_deals", "devices_lost", "lost_revenue", "net_sales", "new_customers", "return_customers",
  "recycle_customers", "no_deal_customers", "total_customers", "reviews_today", "five_star_today",
  "five_star_mtd", "devices_processed", "processed_value", "listed_devices", "queue_count",
  "available_count", "available_cost", "live_count", "team_production",
].join(",");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
// Central, not UTC: the edge runtime is UTC and the stores' day is not.
function centralDay(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}
function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const pin = req.headers.get("x-user-pin") || "";
  if (!pin) return json({ success: false, error: "Missing x-user-pin header" }, 401);
  let { data: user } = await sb.from("users").select("name, role, store").eq("pin", pin).maybeSingle();
  if (!user) ({ data: user } = await sb.from("test_users").select("name, role, store").eq("pin", pin).maybeSingle());
  if (!user) return json({ success: false, error: "Invalid PIN" }, 401);

  const role = String(user.role || "").toLowerCase().trim();
  const home = String(user.store || "").toUpperCase().trim();
  const district = DISTRICT_ROLES.has(role) || home === "CORP" || home === "ALL";
  const stores = district ? STORES
    : role === "multi-store manager" ? MULTISTORE_MANAGER_STORES
    : STORES.filter((s) => home.split(/[^A-Z]+/).includes(s));
  if (!stores.length) return json({ success: false, error: "No store for this person" }, 403);

  const url = new URL(req.url);
  const days = Math.min(120, Math.max(7, Number(url.searchParams.get("days")) || 45));
  const today = centralDay();
  const from = addDays(today, -days);
  const monthStart = today.slice(0, 8) + "01";
  const lastMonthStart = addDays(monthStart, -1).slice(0, 8) + "01";
  const ym = today.slice(0, 7);

  const [factsQ, npQ, goalsQ, cashQ] = await Promise.all([
    sb.from("day_end_facts").select(FACT_COLS).in("store", stores).gte("date", from).order("date"),
    sb.from("daily_np").select("store,date,sales,np").in("store", stores).gte("date", lastMonthStart).order("date"),
    sb.from("monthly_np_goals").select("store,ym,np_goal").in("store", stores).eq("ym", ym),
    CASH_ROLES.has(role)
      ? sb.from("store_cash").select("store,day,drawer,safe,total").in("store", stores).gte("day", addDays(today, -14)).order("day")
      : Promise.resolve({ data: null, error: null }),
  ]);
  const err = factsQ.error || npQ.error || goalsQ.error || cashQ.error;
  if (err) return json({ success: false, error: err.message }, 500);

  // An employee sees the store's totals and their own production line only —
  // the rest of the team's figures are their manager's to read.
  const employee = role === "employee";
  const me = norm(user.name);
  const facts = (factsQ.data || []).map((r: any) => {
    if (!employee || !Array.isArray(r.team_production)) return r;
    return { ...r, team_production: r.team_production.filter((m: any) => norm(m && m.name) === me) };
  });

  let usage = null;
  if (DISTRICT_ROLES.has(role)) {
    // Who signed in on each of the last 14 days, and who on the roster has
    // not opened the site in the last 7. Real people only (users), not tests.
    const { data: ev, error: ue } = await sb.from("usage_events").select("day,user_name,store")
      .eq("event", "signin").gte("day", addDays(today, -14)).limit(5000);
    if (ue) return json({ success: false, error: ue.message }, 500);
    const { data: roster } = await sb.from("users").select("name,store,role");
    const byDay: Record<string, Set<string>> = {};
    const recent = new Set<string>();
    (ev || []).forEach((e: any) => {
      (byDay[e.day] = byDay[e.day] || new Set()).add(norm(e.user_name));
      if (e.day >= addDays(today, -7)) recent.add(norm(e.user_name));
    });
    const people = (roster || []).filter((u: any) => String(u.role || "").toLowerCase() !== "store");
    // Counted against the roster, so a test account or a misspelt name signing
    // in never makes "signed in this week" bigger than the team.
    const onRoster = new Set(people.map((u: any) => norm(u.name)));
    usage = {
      days: Object.keys(byDay).sort().map((d) => ({ day: d, people: [...byDay[d]].filter((n) => onRoster.has(n)).length })),
      week: people.filter((u: any) => recent.has(norm(u.name))).length,
      roster: people.length,
      quiet: people.filter((u: any) => !recent.has(norm(u.name))).map((u: any) => ({ name: u.name, store: u.store })),
    };
  }

  return json({
    success: true, today, stores, role, name: user.name,
    facts, np: npQ.data || [],
    goals: Object.fromEntries((goalsQ.data || []).map((g: any) => [g.store, Number(g.np_goal) || 0])),
    cash: cashQ.data, usage,
  });
});
