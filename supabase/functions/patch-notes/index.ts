import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Realtime "ping": after a successful write, tell signed-in clients this tool
// changed so they re-run their check (which re-fetches through the edge fn — no
// table data travels over realtime). Wrapped so it can never break the write.
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

// Normalize "m/d/yyyy" (legacy client format) to ISO "yyyy-mm-dd". Pass through anything already ISO.
function toISODate(d: string): string {
  if (!d) return d;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return d;
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
  const action = url.searchParams.get("action");
  const user = url.searchParams.get("user");

  if (req.method === "GET") {
    // Return last-seen key for a specific user
    if (action === "getPatchRead" && user) {
      const { data } = await supabase
        .from("patch_note_reads")
        .select("last_seen_key")
        .eq("user_name", user.toLowerCase())
        .limit(1);

      return json({ lastSeenKey: data?.[0]?.last_seen_key || null });
    }

    // Default: return all patch notes as { entries: [...] }
    const { data, error } = await supabase
      .from("patch_notes")
      .select("id, title, date, category, summary")
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) return json({ entries: [] });

    const entries = (data || []).map((r: any) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      category: r.category,
      summary: r.summary,
    }));

    return json({ entries });
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    // Mark a user's patch notes as read
    if (body.action === "markPatchRead" && body.user && body.lastSeenKey) {
      await supabase.from("patch_note_reads").upsert({
        user_name: String(body.user).toLowerCase(),
        last_seen_key: body.lastSeenKey,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_name" });
      return json({ success: true });
    }

    // Add a new version's worth of entries (one row per item)
    if (body.action === "addEntries" && body.title && body.date && Array.isArray(body.items)) {
      const rows = body.items
        .filter((it: any) => it && it.category && it.summary)
        .map((it: any) => ({
          title: body.title,
          date: toISODate(body.date),
          category: it.category,
          summary: it.summary,
        }));
      if (rows.length) {
        const { error } = await supabase.from("patch_notes").insert(rows);
        if (error) return json({ error: error.message }, 500);
        await broadcastChange("patch", null);
      }
      return json({ success: true, inserted: rows.length });
    }

    // Edit the version title/date for a whole group (all rows sharing the old title+date)
    if (body.action === "editGroup" && body.oldTitle && body.oldDate && body.title && body.date) {
      const { error } = await supabase
        .from("patch_notes")
        .update({ title: body.title, date: toISODate(body.date) })
        .eq("title", body.oldTitle)
        .eq("date", toISODate(body.oldDate));
      if (error) return json({ error: error.message }, 500);
      await broadcastChange("patch", null);
      return json({ success: true });
    }

    // Edit a single entry by id
    if (body.action === "editEntry" && body.id) {
      const { error } = await supabase
        .from("patch_notes")
        .update({
          title: body.title,
          date: toISODate(body.date),
          category: body.category,
          summary: body.summary,
        })
        .eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      await broadcastChange("patch", null);
      return json({ success: true });
    }

    // Delete a single entry by id
    if (body.action === "deleteEntry" && body.id) {
      const { error } = await supabase.from("patch_notes").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      await broadcastChange("patch", null);
      return json({ success: true });
    }

    return json({ success: true });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
