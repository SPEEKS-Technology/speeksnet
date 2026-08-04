import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * MONTHLY GOALS / INITIATIVES / COMPANY PROJECTS
 *
 * Replaces the Google Apps Script at MONTHLY_GOALS_URL, which was the last piece
 * of the app still writing to a spreadsheet instead of Supabase.
 *
 * This deliberately speaks the SAME wire protocol as the Apps Script it replaces
 * (same query actions, same JSON shapes, same POST bodies) so the frontend cutover
 * is a one-line URL change rather than a rewrite of every call site. Do not
 * "tidy" the response shapes without updating speeks.js in the same commit.
 *
 * Storage — all three datasets share public.goals, distinguished by year_month:
 *   monthly goals      store = OVL|LEE|WSP|MPL|BAL, year_month = 'YYYY-MM'
 *   store initiatives  store = OVL|LEE|WSP|MPL|BAL, year_month = 'initiatives'
 *   company projects   store = 'COMPANY',           year_month = 'initiatives'
 * `status` ('current' | 'upcoming') applies to initiatives/projects only; monthly
 * goals leave it null.
 *
 * Reads are GET, writes are POST — the frontend's test-mode write guard relies on
 * that split, so keep any new read on GET.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const INITIATIVES_KEY = "initiatives";   // sentinel year_month for non-monthly rows
const COMPANY_KEY = "COMPANY";           // sentinel store for company-wide projects

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// The frontend renders updatedAt as-is, and writes it as "July 21, 2026". Give it
// back in that same shape rather than a raw ISO timestamp.
function displayDate(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago",
  });
}

// Incoming updatedAt is a display string ("July 21, 2026") or a JS date string.
// Store a real timestamp; fall back to now() rather than rejecting the save.
function parseDate(v: unknown): string {
  const d = v ? new Date(String(v)) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);

  try {
    /* ------------------------------- READS ------------------------------- */
    if (req.method === "GET") {
      const action = url.searchParams.get("action") || "";

      if (action === "getAll") {
        const yearMonth = url.searchParams.get("yearMonth") || "";
        const { data, error } = await supabase
          .from("goals")
          .select("store, title, description, set_by, updated_at, goal_number")
          .eq("year_month", yearMonth)
          .order("goal_number", { ascending: true });
        if (error) throw error;

        // Every store is present even with no goals — the frontend iterates the
        // full store list and the old sheet always returned an entry per store.
        const out: Record<string, unknown> = {};
        for (const store of STORES) {
          const rows = (data || []).filter((r: any) => r.store === store);
          out[store] = {
            goals: rows.map((r: any) => ({ title: r.title, description: r.description || "" })),
            setBy: rows[0]?.set_by || "",
            updatedAt: displayDate(rows[0]?.updated_at || null),
          };
        }
        return json(out);
      }

      if (action === "getAllInitiatives") {
        const { data, error } = await supabase
          .from("goals")
          .select("store, title, description, status, set_by, updated_at, goal_number")
          .eq("year_month", INITIATIVES_KEY)
          .order("goal_number", { ascending: true });
        if (error) throw error;

        const pick = (store: string) => (data || []).filter((r: any) => r.store === store);

        const companyRows = pick(COMPANY_KEY);
        const out: Record<string, unknown> = {
          company: {
            projects: companyRows.map((r: any) => ({
              title: r.title, description: r.description || "", status: r.status || "current",
            })),
            setBy: companyRows[0]?.set_by || "",
            updatedAt: displayDate(companyRows[0]?.updated_at || null),
          },
        };
        for (const store of STORES) {
          const rows = pick(store);
          out[store] = {
            initiatives: rows.map((r: any) => ({
              title: r.title, description: r.description || "", status: r.status || "current",
            })),
            setBy: rows[0]?.set_by || "",
            updatedAt: displayDate(rows[0]?.updated_at || null),
          };
        }
        return json(out);
      }

      return json({ error: "unknown action" }, 400);
    }

    /* ------------------------------- WRITES ------------------------------ */
    if (req.method === "POST") {
      // The frontend posts as text/plain (an Apps Script habit that avoided a CORS
      // preflight), so never rely on the content-type header here.
      const raw = await req.text();
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: "bad json" }, 400); }

      const setBy = String(body.setBy || "").trim();
      const updatedAt = parseDate(body.updatedAt);

      // Each save REPLACES the whole set for its scope — the editor always submits
      // the complete list, and rows carry no stable id, so delete-then-insert keeps
      // ordering honest and drops removed entries. Scoped tightly enough that it
      // can only ever clear the one store/month being edited.
      async function replaceScope(store: string, yearMonth: string, rows: any[]) {
        const { error: delErr } = await supabase
          .from("goals").delete().eq("store", store).eq("year_month", yearMonth);
        if (delErr) throw delErr;
        if (!rows.length) return;
        const { error: insErr } = await supabase.from("goals").insert(rows);
        if (insErr) throw insErr;
      }

      if (body.action === "setCompanyProjects") {
        const rows = (body.projects || [])
          .filter((p: any) => p && String(p.title || "").trim())
          .map((p: any, i: number) => ({
            store: COMPANY_KEY, year_month: INITIATIVES_KEY, goal_number: i + 1,
            title: String(p.title).trim(), description: p.description || null,
            status: p.status || "current", set_by: setBy, updated_at: updatedAt,
          }));
        await replaceScope(COMPANY_KEY, INITIATIVES_KEY, rows);
        return json({ ok: true, saved: rows.length });
      }

      if (body.action === "setStoreInitiatives") {
        const store = String(body.store || "").trim().toUpperCase();
        if (!STORES.includes(store)) return json({ error: "unknown store" }, 400);
        const rows = (body.initiatives || [])
          .filter((it: any) => it && String(it.title || "").trim())
          .map((it: any, i: number) => ({
            store, year_month: INITIATIVES_KEY, goal_number: i + 1,
            title: String(it.title).trim(), description: it.description || null,
            status: it.status || "current", set_by: setBy, updated_at: updatedAt,
          }));
        await replaceScope(store, INITIATIVES_KEY, rows);
        return json({ ok: true, saved: rows.length });
      }

      // No action => monthly goals save (matches the old script's default branch).
      const store = String(body.store || "").trim().toUpperCase();
      const yearMonth = String(body.yearMonth || "").trim();
      if (!STORES.includes(store)) return json({ error: "unknown store" }, 400);
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) return json({ error: "bad yearMonth" }, 400);

      const rows = (body.goals || [])
        .filter((g: any) => g && String(g.title || "").trim())
        .map((g: any, i: number) => ({
          store, year_month: yearMonth, goal_number: i + 1,
          title: String(g.title).trim(), description: g.description || null,
          status: null, set_by: setBy, updated_at: updatedAt,
        }));
      await replaceScope(store, yearMonth, rows);
      return json({ ok: true, saved: rows.length });
    }

    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    console.error("monthly-goals error:", err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
