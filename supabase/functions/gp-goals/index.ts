import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// The two decisions a month needs before it starts: each store's gross-profit
// goal, and the days the stores are shut.
//
// ⚠️ NOT the `monthly-goals` function, which is a different feature entirely
// (the written goals/initiatives panel), and NOT `store_monthly_goals`, which
// holds REVENUE goals and has been dead since May 2026. This is the dollar GP
// goal behind the Daily Breakdown's goal bar and the workbook's "GP Goal" cell.
//
// DIRECTION OF TRAVEL IS SITE -> SHEET. A goal is a decision, not a
// measurement: the DM makes it once a month, here, and it is pushed into the
// workbook so the sheet's own formulas keep working. Nothing reads it back off
// the sheet, so the two can never disagree about who decided.
//
//   GET  ?month=YYYY-MM
//        -> { month, goals, total, complete, missing,
//             closed:[{day,label}], days, sundays, buyingDays }
//   POST { action:'save', month, goals, closed? }  (x-user-pin, District Manager)
//
// `buyingDays` is DERIVED (days − Sundays − closures) and never stored. The
// dates are what is kept, because the daily import needs to know WHICH days to
// skip, not just how many.
//
// Reads are open, like buysell-daily: the goal is already on screen in the goal
// bar for anyone who can see the dashboard. Writes need a pin, and a role the
// Feature Access tool agrees with.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// A goal is a month's gross profit for one store. Six figures is already
// unusual; seven is a typo with a zero in it, and it would silently rescale
// every goal bar on the site.
const MAX_GOAL = 1_000_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// WHO MAY SET A GOAL. The District Manager, and nobody else by default — not
// even the CEO (Ethan's call 2026-08-12) — unless the Feature Access tool has
// handed 'tool-store-goals' to another role or person. That switch is the same
// one the frontend reads to show the tool, so what is visible and what is
// permitted cannot drift apart: a user override beats a role override beats the
// default, exactly as _featureOverrideFor resolves it in the browser.
const GOAL_FEATURE = "tool-store-goals";

async function mayEdit(
  supabase: ReturnType<typeof createClient>,
  name: string,
  role: string,
): Promise<boolean> {
  // Normalised exactly as the browser does it, so the slug matched here is the
  // slug the Feature Access tool writes.
  const roleClass = (role || "").toLowerCase().trim()
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-");
  const byDefault = roleClass === "district-manager";

  const { data } = await supabase
    .from("feature_overrides")
    .select("subject_type, subject, enabled")
    .eq("feature_key", GOAL_FEATURE);

  const lc = (v: unknown) => String(v || "").toLowerCase().trim();
  const forUser = (data || []).find((r) => lc(r.subject_type) === "user" && lc(r.subject) === lc(name));
  if (forUser) return !!forUser.enabled;
  const forRole = (data || []).find((r) => lc(r.subject_type) === "role" && lc(r.subject) === roleClass);
  if (forRole) return !!forRole.enabled;
  return byDefault;
}

// The edge runtime is UTC, so a bare new Date() names the wrong month for the
// first six hours of the 1st — which is exactly the day this function is busiest.
function centralMonth(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }).slice(0, 7);
}

// ---- buying days -----------------------------------------------------------
// The stores do not buy on Sundays, and they do not buy on the days they are
// shut. What is left is the month's buying days — the denominator behind the
// Buy tab's tracking, and DERIVED here rather than typed anywhere.
//
// The count is not what gets stored: the DATES are. A count alone fixes the
// month's total and leaves the daily "Days thru Month" counter still treating
// the holiday as a working day, which skews tracking for the rest of the month.
// Everything downstream re-derives from the list.
//
// Built from the parts, never Date.parse('YYYY-MM') — that reads as UTC and
// lands a day early, which would shift every Sunday in the month.
function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
function sundaysIn(ym: string): number[] {
  const [y, m] = ym.split("-").map(Number);
  const out: number[] = [];
  for (let d = 1; d <= daysInMonth(ym); d++) if (new Date(y, m - 1, d).getDay() === 0) out.push(d);
  return out;
}
function buyingDays(ym: string, closed: number[]): number {
  const sun = new Set(sundaysIn(ym));
  let n = 0;
  for (let d = 1; d <= daysInMonth(ym); d++) {
    // A closure that falls on a Sunday is already excluded — counting it twice
    // would take a day off the month for nothing.
    if (sun.has(d) || closed.includes(d)) continue;
    n++;
  }
  return n;
}

// Realtime is a PING, not a payload: the client re-runs its own check when it
// hears this, so nothing sensitive travels over the broadcast channel.
async function broadcastChange(tool: string) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort */ }
}

// Push the month's goals into the workbook, so the sheet's own GP-goal cells
// agree with what was entered here. Best-effort ON PURPOSE: the save has already
// succeeded by the time this runs, and a Google outage must not fail it or the
// DM would key the same five numbers again. The rollover writes them too, so a
// failure here is corrected on the 1st at the latest.
async function pushToSheet(
  month: string,
  goals: Record<string, number>,
  buyDays: number | null,
): Promise<string> {
  const url = Deno.env.get("MONTH_ROLLOVER_URL");
  const secret = Deno.env.get("SYNC_SECRET");
  if (!url || !secret) return "not configured";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "goals", secret, month, goals, buyDays }),
      redirect: "follow",
    });
    const txt = (await res.text()).slice(0, 300);
    return res.ok ? "ok " + txt : "HTTP " + res.status + " " + txt;
  } catch (e) {
    return "failed: " + String((e as Error)?.message || e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      const asked = String(url.searchParams.get("month") || "").trim();
      const month = /^\d{4}-\d{2}$/.test(asked) ? asked : centralMonth();
      const { data, error } = await supabase
        .from("monthly_gp_goals")
        .select("store, gp_goal, set_by, set_at")
        .eq("ym", month);
      if (error) throw error;

      const goals: Record<string, number> = {};
      let setBy = "", setAt = "";
      for (const r of data || []) {
        const code = String(r.store || "").toUpperCase();
        if (!STORES.includes(code)) continue;
        goals[code] = Number(r.gp_goal);
        if (!setAt || String(r.set_at) > setAt) { setAt = String(r.set_at); setBy = String(r.set_by || ""); }
      }
      const { data: shut } = await supabase
        .from("monthly_closed_days")
        .select("day, label")
        .eq("ym", month)
        .order("day");
      const closed = (shut || [])
        .map((r) => ({ day: Number(r.day), label: String(r.label || "") }))
        .filter((c) => c.day >= 1 && c.day <= daysInMonth(month));

      // `missing` is what drives the reminder on the site, so it is computed
      // here rather than left to each caller to work out for itself. Closures
      // are deliberately NOT part of it: most months have none, and a card that
      // nags for an empty list would cry wolf eleven times a year.
      const missing = STORES.filter((s) => !(s in goals));
      return json({
        month,
        goals,
        total: Object.values(goals).reduce((a, b) => a + b, 0),
        complete: missing.length === 0,
        missing,
        setBy,
        setAt,
        closed,
        days: daysInMonth(month),
        sundays: sundaysIn(month).length,
        buyingDays: buyingDays(month, closed.map((c) => c.day)),
      });
    }

    if (req.method === "POST") {
      const pin = req.headers.get("x-user-pin") || "";
      if (!pin) return json({ error: "Missing x-user-pin header" }, 401);
      const { data: user } = await supabase
        .from("users").select("name, role").eq("pin", pin).single();
      if (!user) return json({ error: "Unknown pin" }, 401);
      if (!(await mayEdit(supabase, String(user.name || ""), String(user.role || "")))) {
        return json({ error: "Not allowed" }, 403);
      }

      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (body.action !== "save") return json({ error: "Unknown action" }, 400);

      const month = String(body.month || "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "Bad month" }, 400);

      const raw = (body.goals || {}) as Record<string, unknown>;
      const rows: { store: string; ym: string; gp_goal: number; set_by: string }[] = [];
      for (const code of STORES) {
        if (!(code in raw)) continue;
        const v = Number(raw[code]);
        // A blank clears the goal rather than storing a zero — "not decided yet"
        // and "the goal is nothing" are different, and only the first should
        // leave the reminder standing.
        if (raw[code] === "" || raw[code] === null) continue;
        if (!Number.isFinite(v) || v < 0) return json({ error: `Bad goal for ${code}` }, 400);
        if (v > MAX_GOAL) return json({ error: `${code}'s goal looks like a typo (over $1M)` }, 400);
        rows.push({ store: code, ym: month, gp_goal: Math.round(v * 100) / 100, set_by: String(user.name || "") });
      }

      const clear = STORES.filter((c) => c in raw && !rows.some((r) => r.store === c));
      if (clear.length) {
        const { error } = await supabase
          .from("monthly_gp_goals").delete().eq("ym", month).in("store", clear);
        if (error) throw error;
      }
      if (rows.length) {
        const { error } = await supabase
          .from("monthly_gp_goals").upsert(rows, { onConflict: "store,ym" });
        if (error) throw error;
      }

      // ---- closed days ----
      // Sent only when the panel had them on screen. An ABSENT `closed` key
      // means "not editing that", while an empty array means "there are none" —
      // the difference matters, because the second must be able to clear a
      // closure that was added by mistake.
      let buyDays: number | null = null;
      if (Array.isArray(body.closed)) {
        const seen = new Set<number>();
        const shut: { ym: string; day: number; label: string; set_by: string }[] = [];
        for (const item of body.closed as unknown[]) {
          const entry = (item || {}) as Record<string, unknown>;
          const day = Number(entry.day);
          if (!Number.isInteger(day) || day < 1 || day > daysInMonth(month)) {
            return json({ error: `${entry.day} is not a day in ${month}` }, 400);
          }
          if (seen.has(day)) continue;
          seen.add(day);
          shut.push({ ym: month, day, label: String(entry.label || "").slice(0, 60), set_by: String(user.name || "") });
        }
        const { error: delErr } = await supabase.from("monthly_closed_days").delete().eq("ym", month);
        if (delErr) throw delErr;
        if (shut.length) {
          const { error: insErr } = await supabase.from("monthly_closed_days").insert(shut);
          if (insErr) throw insErr;
        }
        buyDays = buyingDays(month, shut.map((s) => s.day));
      }

      const sheet = await pushToSheet(month, Object.fromEntries(rows.map((r) => [r.store, r.gp_goal])), buyDays);
      await broadcastChange("gpGoals");

      const missing = STORES.filter((s) => !rows.some((r) => r.store === s));
      return json({ success: true, month, saved: rows.length, missing, complete: missing.length === 0, buyDays, sheet });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
