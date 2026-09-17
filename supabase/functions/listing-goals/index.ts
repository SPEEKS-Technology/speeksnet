import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Realtime "ping": after a successful write, tell signed-in clients this tool
// changed so they re-run their check (which re-fetches through the edge fn).
// Best-effort — a broadcast failure can never break the write.
async function broadcastChange(tool: string, store: string | null) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: store ? String(store).toUpperCase() : null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);
  const store = url.searchParams.get("store")?.toUpperCase();

  if (req.method === "GET") {
    if (!store) {
      return new Response(JSON.stringify([]), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Return last 90 days of data for this store
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const sinceStr = since.toISOString().split("T")[0];

    const { data, error } = await supabase
      .from("listing_goals")
      .select("date, store, employee, role, goal, result")
      .eq("store", store)
      .gte("date", sinceStr)
      .order("date", { ascending: false });

    if (error) {
      return new Response(JSON.stringify([]), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Format date as locale string to match frontend's toLocaleDateString
    const result = (data || []).map((r: any) => ({
      date: new Date(r.date + "T12:00:00Z").toLocaleDateString("en-US"),
      store: r.store,
      employee: r.employee,
      role: r.role,
      goal: r.goal,
      result: r.result,
    }));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    // Body: { store, date, employees: [{employee, role, goal, result}] }
    let body: any;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { store: bodyStore, date: dateStr, employees } = body;
    if (!bodyStore || !dateStr || !Array.isArray(employees)) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Convert locale date string to ISO date
    const isoDate = new Date(dateStr).toISOString().split("T")[0];
    const storeCode = bodyStore.toUpperCase();

    // ⚠️ UPSERT, NOT DELETE-THEN-INSERT.
    //
    // This used to delete every row for (store, date) and then insert the roster
    // fresh. With no transaction around the pair, two saves in flight at once —
    // a manager's debounced autosave landing while a second client saves, or one
    // double-tap — interleave as delete, delete, insert, insert, and the day ends
    // up holding two complete copies of itself.
    //
    // That was not theoretical: on 2026-09-09 every one of OVL's six people had
    // exactly two rows. The widget hid it (renderGoalsScoreboard keeps the last
    // row per day) but the server did not — breakdown() sums every row into
    // `adjusted`, the Staffed For column and the denominator of the efficiency
    // ratio, so a duplicated day inflated it by a whole day's goals and dropped
    // OVL's week from 49% to 42% on the DM's board.
    //
    // The unique index from migration 0092 is what makes this safe: the second
    // writer now collides with the first and overwrites it instead of adding to
    // it. An upsert with nothing to conflict on is just an insert, so the index
    // is load-bearing here, not belt-and-braces.
    if (employees.length > 0) {
      const rows = employees.map((e: any) => ({
        date: isoDate,
        store: storeCode,
        employee: e.employee,
        role: e.role || "",
        goal: parseInt(e.goal) || 0,
        result: parseInt(e.result) || 0,
      }));
      const { error: upsertError } = await supabase
        .from("listing_goals")
        .upsert(rows, { onConflict: "store,date,employee" });
      if (upsertError) {
        return new Response(JSON.stringify({ error: upsertError.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Anyone who WAS on this day's board and is no longer on the posted roster —
    // someone removed from the store, or a floater who went elsewhere. Scoped to
    // this store and date, so it can only ever clear rows the save is replacing.
    const keep = employees.map((e: any) => e.employee).filter(Boolean);
    let stale = supabase.from("listing_goals").delete()
      .eq("store", storeCode).eq("date", isoDate);
    if (keep.length > 0) {
      // PostgREST needs the list quoted — a name contains spaces, and unquoted
      // it would be parsed as several values.
      stale = stale.not("employee", "in", `(${keep.map((n: string) => `"${n.replace(/"/g, '""')}"`).join(",")})`);
    }
    await stale;

    await broadcastChange("goals", bodyStore);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
