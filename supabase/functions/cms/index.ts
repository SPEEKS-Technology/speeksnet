import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Rolling window for the announcement BOARD: only serve announcements from the last
// ROLLING_DAYS days (undated rows are kept as a safety net — never silently hide
// something with no date). Old posts drop off the board even if they had a document
// attached; the document itself is preserved separately in the `documents` list below,
// so the Documents section keeps every attachment forever regardless of age.
const ROLLING_DAYS = 30;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // PostgREST caps an unbounded .select() at ~1000 rows. announcement_reads grew past
  // that (1000+ read receipts), so the newest reads were silently dropped and recent
  // announcements showed "0 read" while reactions (still under 1000) looked fine. Page
  // through in 1000-row chunks so every row is returned regardless of table size.
  async function selectAll(table: string, columns: string, orderBy?: string): Promise<any[]> {
    const pageSize = 1000;
    let from = 0;
    const all: any[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let q = supabase.from(table).select(columns);
      if (orderBy) q = q.order(orderBy);
      const { data, error } = await q.range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode");

    const cutoff = new Date(Date.now() - ROLLING_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    // Board membership: within the rolling window, or undated (safety). Documents are
    // handled independently below, so a doc attachment does NOT keep an old post here.
    const keep = (a: any) => !a.date || a.date >= cutoff;

    try {
      // ── Lightweight reactions-only poll ────────────────────────────────
      // Returns ONLY announcement ids + their reaction maps (no message text, no
      // readBy). Every open dashboard hits this on a short timer, so it must stay
      // tiny. Same rowId set as the full GET, so the client's "was a new announcement
      // posted?" check still works and can fall back to a full reload when needed.
      if (mode === "reactions") {
        const [annRows, reactionRows, userRows] = await Promise.all([
          selectAll("announcements", "id, date, doc_url", "created_at"),
          selectAll("announcement_reactions", "announcement_id, user_pin, emoji"),
          selectAll("users", "pin, name"),
        ]);

        const pinToName: Record<string, string> = {};
        userRows.forEach((u: any) => { pinToName[u.pin] = u.name; });

        const reactionsMap: Record<string, Record<string, string[]>> = {};
        reactionRows.forEach((r: any) => {
          if (!reactionsMap[r.announcement_id]) reactionsMap[r.announcement_id] = {};
          if (!reactionsMap[r.announcement_id][r.emoji]) reactionsMap[r.announcement_id][r.emoji] = [];
          reactionsMap[r.announcement_id][r.emoji].push(pinToName[r.user_pin] || r.user_pin);
        });

        const announcements = annRows.filter(keep).map((a: any) => ({
          rowId: a.id,
          reactions: reactionsMap[a.id] || {},
        }));

        return new Response(JSON.stringify({ announcements }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ── Full board ─────────────────────────────────────────────────────
      const [annRows, readRows, reactionRows, userRows] = await Promise.all([
        selectAll("announcements", "id, message, date, author, high_priority, doc_url, doc_name", "created_at"),
        selectAll("announcement_reads", "announcement_id, user_pin"),
        selectAll("announcement_reactions", "announcement_id, user_pin, emoji"),
        selectAll("users", "pin, name"),
      ]);

      const pinToName: Record<string, string> = {};
      userRows.forEach((u: any) => { pinToName[u.pin] = u.name; });

      const readsMap: Record<string, string[]> = {};
      readRows.forEach((r: any) => {
        if (!readsMap[r.announcement_id]) readsMap[r.announcement_id] = [];
        readsMap[r.announcement_id].push(pinToName[r.user_pin] || r.user_pin);
      });

      const reactionsMap: Record<string, Record<string, string[]>> = {};
      reactionRows.forEach((r: any) => {
        if (!reactionsMap[r.announcement_id]) reactionsMap[r.announcement_id] = {};
        if (!reactionsMap[r.announcement_id][r.emoji]) reactionsMap[r.announcement_id][r.emoji] = [];
        reactionsMap[r.announcement_id][r.emoji].push(pinToName[r.user_pin] || r.user_pin);
      });

      const announcements = annRows.filter(keep).map((a: any) => ({
        rowId: a.id,
        date: a.date ? a.date + "T00:00:00" : null,
        author: a.author,
        text: a.message,
        docUrl: a.doc_url || null,
        docName: a.doc_name || null,
        readBy: readsMap[a.id] || [],
        reactions: reactionsMap[a.id] || {},
      }));

      // Every announcement that ever had a document attached, regardless of age — this
      // feeds the Documents section so files stay available after the post itself has
      // aged off the board. Compact fields only (no message text / readBy / reactions).
      const documents = annRows
        .filter((a: any) => a.doc_url)
        .map((a: any) => ({
          rowId: a.id,
          date: a.date ? a.date + "T00:00:00" : null,
          author: a.author,
          docUrl: a.doc_url,
          docName: a.doc_name || null,
        }));

      return new Response(JSON.stringify({ announcements, documents, active: [], upcoming: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const type = body.type;

    if (type === "mark_read") {
      const { data: userData } = await supabase
        .from("users")
        .select("pin")
        .ilike("name", body.user)
        .limit(1);
      const userPin = userData?.[0]?.pin;
      if (userPin && Array.isArray(body.rowIds)) {
        await supabase.from("announcement_reads").upsert(
          body.rowIds.map((rid: string) => ({ announcement_id: rid, user_pin: userPin })),
          { onConflict: "announcement_id,user_pin" }
        );
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (type === "reaction") {
      const { data: userData } = await supabase
        .from("users")
        .select("pin")
        .ilike("name", body.user)
        .limit(1);
      const userPin = userData?.[0]?.pin;
      if (userPin) {
        if (body.removeEmoji) {
          await supabase.from("announcement_reactions")
            .delete()
            .eq("announcement_id", body.rowId)
            .eq("user_pin", userPin)
            .eq("emoji", body.removeEmoji);
        }
        if (body.addEmoji) {
          await supabase.from("announcement_reactions")
            .delete()
            .eq("announcement_id", body.rowId)
            .eq("user_pin", userPin)
            .eq("emoji", body.addEmoji);
          await supabase.from("announcement_reactions").insert({
            announcement_id: body.rowId,
            user_pin: userPin,
            emoji: body.addEmoji,
          });
        }
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Publish new announcement (type === 'publish' or legacy posts without type)
    if (type === "publish" || (body.text && body.author)) {
      const today = new Date().toISOString().split('T')[0];
      const { data: inserted, error } = await supabase.from("announcements").insert({
        message: body.text,
        date: today,
        author: body.author,
        high_priority: !!body.high_priority,
        doc_url: body.doc_url || null,
        doc_name: body.doc_name || null,
      }).select("id").single();
      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Auto-mark the announcement as read for its author — the poster shouldn't
      // have to dismiss their own post. Best-effort: skip silently if the author
      // name doesn't resolve to a user (e.g. the 'Executive Team' fallback).
      if (inserted?.id && body.author) {
        const { data: authorRow } = await supabase
          .from("users")
          .select("pin")
          .ilike("name", body.author)
          .limit(1);
        const authorPin = authorRow?.[0]?.pin;
        if (authorPin) {
          await supabase.from("announcement_reads").upsert(
            { announcement_id: inserted.id, user_pin: authorPin },
            { onConflict: "announcement_id,user_pin" }
          );
        }
      }

      return new Response(JSON.stringify({ success: true, id: inserted?.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
