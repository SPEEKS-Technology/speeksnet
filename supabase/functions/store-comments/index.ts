import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // x-user-pin: the sender's PIN, so the publish path can resolve their REAL role
  // rather than trusting body.author. Without it here the browser's preflight
  // rejects the header and the role silently comes back empty.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
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

// Realtime "ping": after a successful write, tell signed-in clients this tool
// changed so they re-run their check (which re-fetches through the edge fn — no
// table data travels over realtime, so the RLS-locked tables stay closed to the
// anon client). Wrapped so a broadcast failure can never break the write.
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

// Drop a row on the email-notification queue — the twin of broadcastChange
// above. That one tells an already-open page to refresh; this one tells the
// people who aren't looking at the site right now.
//
// All this has to do is describe WHO CARES. The notify function resolves
// audience -> people -> their preferences -> an address, and batches whatever is
// outstanding into one message. Leaving audienceStores/audienceRoles null means
// "everybody".
//
// Best-effort and never throws, for the same reason broadcastChange isn't
// awaited for its result: failing to notify must never fail the write itself.
// See migration 0033 for the audience axes and the category list.
async function queueNotification(n: {
  category: string; kind: string; title: string; body?: string; link?: string;
  store?: string | null; audienceStores?: string[] | null; audienceRoles?: string[] | null;
  audienceUser?: string | null; excludeUser?: string | null; priority?: "normal" | "high";
}) {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    await sb.from("notify_queue").insert({
      category: n.category, kind: n.kind, title: n.title, body: n.body ?? null,
      link: n.link ?? null,
      store: n.store ? String(n.store).toUpperCase() : null,
      audience_stores: n.audienceStores ?? null,
      audience_roles: n.audienceRoles ?? null,
      audience_user: n.audienceUser ? String(n.audienceUser).trim().toLowerCase() : null,
      exclude_user: n.excludeUser ? String(n.excludeUser).trim().toLowerCase() : null,
      priority: n.priority ?? "normal",
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

  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode");

    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().split("T")[0];

    // ── Read-receipts view ────────────────────────────────────────────
    // Recent comments with who has read them (dismissed the bubble). Called by
    // the Send Store Comment tool, so it isn't in the lean poll. An optional
    // `stores` param (comma-separated) scopes the result to those store(s) —
    // managers pass their own store(s) so they only see their store's messages;
    // DM/CEO omit it and get every store.
    if (mode === "reads") {
      const storesParam = url.searchParams.get("stores");
      const storeFilter = storesParam
        ? storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
        : null;

      let query = supabase
        .from("store_comments")
        .select("id, date, store, author, message")
        .gt("created_at", READS_TRACKING_SINCE)
        .order("created_at", { ascending: false });
      if (storeFilter && storeFilter.length) query = query.in("store", storeFilter);
      const { data: comments, error } = await query;
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
      .select("id, date, store, author, message, created_at")
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
      created_at: r.created_at, // real send time, so the feed can show/sort by it
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

    await broadcastChange("comments", store);

    // Email the store. Who a message is FROM matters here in a way it doesn't for
    // the on-screen card: three different roles can send one (a Manager to their
    // own store via openManagerStoreComment, the DM, or the CEO), and an email
    // that just says "a message arrived" wastes the most useful thing about it.
    //
    // ⚠️ body.author is NOT trusted for this. It is whatever the client sent,
    // defaulting to "Executive Team" — fine for a display name, useless as a
    // statement of authority. The sender's real role is resolved by PIN below, the
    // same way email-recipients re-checks a role it was told about, so the phrase
    // "from your Manager" in somebody's inbox is something the server verified.
    // A request with no usable PIN simply gets the neutral wording.
    {
      const senderPin = req.headers.get("x-user-pin") || body.pin || "";
      let senderRole = "";
      let senderName = String(author);
      if (senderPin) {
        const { data: sender } = await supabase
          .from("users").select("name, role").eq("pin", senderPin).maybeSingle();
        if (sender) {
          senderName = String(sender.name || author);
          const raw = String(sender.role || "").toLowerCase().trim();
          senderRole = raw === "district manager" ? "District Manager"
            : raw === "ceo" ? "CEO"
            : (raw === "manager" || raw === "owner (manager)" || raw === "multi-store manager") ? "Manager"
            : "";
        }
      }
      const from = senderRole ? `${senderName} (${senderRole})` : senderName;
      // A comment to "ALL" is a company-wide message, so it carries no store
      // filter; anything else is scoped to that one store's people.
      await queueNotification({
        category: "store_messages",
        kind: "store_comment",
        title: `Message from ${from}`,
        body: message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
        link: "index.html",
        store: store === "ALL" ? null : store,
        audienceStores: store === "ALL" ? null : [store],
        excludeUser: senderName,
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
