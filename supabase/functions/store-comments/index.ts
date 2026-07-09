import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Read-receipt tracking was reset here — the earlier X-dismiss behavior wasn't a
// true mark-as-read, so those counts were unreliable. The Read Receipts view only
// shows comments sent AFTER this cutoff, so stats start clean from the next comment.
const READS_TRACKING_SINCE = "2026-07-09T21:53:42Z";

// Convert ISO date string (e.g. "2026-05-21") to US locale (e.g. "5/21/2026")
// Uses noon UTC so the date never shifts when converted to US timezones.
function isoToLocale(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode");

    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().split("T")[0];

    // ── DM/CEO read-receipts view ─────────────────────────────────────
    // Recent comments with who has read them (dismissed the bubble). Only the
    // Send Store Comment tool (DM/CEO) calls this, so it isn't in the lean poll.
    if (mode === "reads") {
      const { data: comments, error } = await supabase
        .from("store_comments")
        .select("id, date, store, author, message")
        .gt("created_at", READS_TRACKING_SINCE)
        .order("created_at", { ascending: false });
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const ids = (comments || []).map((c: any) => c.id);
      const byComment: Record<string, string[]> = {};
      if (ids.length) {
        const { data: reads } = await supabase
          .from("store_comment_reads")
          .select("comment_id, user_name")
          .in("comment_id", ids)
          .range(0, 9999);
        (reads || []).forEach((r: any) => {
          (byComment[r.comment_id] ||= []).push(r.user_name || "Unknown");
        });
      }
      const result = (comments || []).map((c: any) => ({
        id: c.id,
        date: isoToLocale(c.date),
        store: c.store,
        author: c.author,
        message: c.message,
        readBy: byComment[c.id] || [],
        readCount: (byComment[c.id] || []).length,
      }));
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Normal poll: today's comments for the bubble (now includes id) ─
    const { data, error } = await supabase
      .from("store_comments")
      .select("id, date, store, author, message")
      .gte("date", sinceStr)
      .order("created_at", { ascending: false });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // When a reader is named, flag which of these comments they've already read
    // (dismissed) so the client can permanently suppress them across sessions.
    const reader = url.searchParams.get("reader");
    const readSet = new Set<string>();
    if (reader) {
      let pin: string | null = null;
      const { data: u } = await supabase
        .from("users").select("pin").ilike("name", reader).limit(1);
      pin = u?.[0]?.pin || null;
      const key = pin || reader.toLowerCase();
      const ids = (data || []).map((r: any) => r.id);
      if (ids.length) {
        const { data: reads } = await supabase
          .from("store_comment_reads")
          .select("comment_id")
          .eq("user_pin", key)
          .in("comment_id", ids)
          .range(0, 9999);
        (reads || []).forEach((r: any) => readSet.add(r.comment_id));
      }
    }

    const result = (data || []).map((r: any) => ({
      id: r.id,
      date: isoToLocale(r.date),
      store: r.store,
      author: r.author,
      message: r.message,
      readByMe: readSet.has(r.id),
    }));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    let body: any = {};
    try {
      const text = await req.text();
      body = JSON.parse(text);
    } catch (_) {}

    // ── Mark comment(s) read (bubble dismissed) ───────────────────────
    if (body.type === "mark_read") {
      const commentIds: string[] = Array.isArray(body.commentIds)
        ? body.commentIds
        : (body.commentId ? [body.commentId] : []);
      const userName: string | null = body.user ? String(body.user).trim() : null;
      if (!commentIds.length) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Resolve a stable dedupe key: real pin if the name maps to a user,
      // otherwise the lowercased name so repeat dismissals don't double-count.
      let pin: string | null = null;
      if (userName) {
        const { data: u } = await supabase
          .from("users").select("pin").ilike("name", userName).limit(1);
        pin = u?.[0]?.pin || null;
      }
      const key = pin || (userName ? userName.toLowerCase() : "unknown");
      const rows = commentIds.map((cid) => ({
        comment_id: cid, user_pin: key, user_name: userName,
      }));
      const { error } = await supabase
        .from("store_comment_reads")
        .upsert(rows, { onConflict: "comment_id,user_pin" });
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Publish a store comment ───────────────────────────────────────
    const store = (body.store || "ALL").toUpperCase();
    const author = body.author || "Executive Team";
    const message = (body.message || "").trim();

    if (!message) {
      return new Response(JSON.stringify({ error: "Missing message" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Chicago",
    });
    // Convert locale date back to ISO for the date column
    const [month, day, year] = today.split("/");
    const isoDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

    const { error } = await supabase.from("store_comments").insert({
      date: isoDate,
      store,
      author,
      message,
    });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
