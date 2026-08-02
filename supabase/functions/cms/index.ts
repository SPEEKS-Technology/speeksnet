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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Who can file and remove documents: DM and CEO only (Ethan, 2026-08-01). This is
// deliberately narrower than the Announcements tool, which also opens to Tom and
// the Owner (Manager) — posting is a one-way act, whereas removing from the shared
// Documents list takes a file away from every store.
//
// Normalized rather than matched literally: the session stores "district manager"
// with a space while Feature Access keys it "district-manager", and matching one
// spelling silently locks out whoever sends the other (exactly the bug that made
// every DM write to the Margin Guide fail).
const DOC_ROLES = ["district-manager", "ceo"];
const normRole = (r: unknown) =>
  String(r ?? "").toLowerCase().trim().replace(/[()]/g, " ").replace(/[\s_]+/g, "-").replace(/^-|-$/g, "");

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
    //
    // doc_only rows are files filed straight into the Documents view. They are stored
    // as announcements so they can share the `documents` list, the storage bucket and
    // the title matching — but they were never posted, so they must not reach the
    // board, the feed, the ticker or the unread badge. Excluded here, once, for both
    // GET payloads; `documents` below deliberately keeps them.
    const keep = (a: any) => !a.doc_only && (!a.date || a.date >= cutoff);

    try {
      // ── Lightweight reactions-only poll ────────────────────────────────
      // Returns ONLY announcement ids + their reaction maps (no message text, no
      // readBy). Every open dashboard hits this on a short timer, so it must stay
      // tiny. Same rowId set as the full GET, so the client's "was a new announcement
      // posted?" check still works and can fall back to a full reload when needed.
      if (mode === "reactions") {
        const [annRows, reactionRows, userRows] = await Promise.all([
          selectAll("announcements", "id, date, doc_url, doc_only", "created_at"),
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
        selectAll("announcements", "id, message, date, author, high_priority, doc_url, doc_name, doc_only", "created_at"),
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

      // The Documents view labels each file with the announcement it came with, and
      // files goals/bonus sheets by those words — both need the title. Shipping the
      // whole message body back would undo the egress trim this list exists to allow,
      // so derive just the title here: the first <strong>, which is exactly where the
      // client's _hubParseAnn looks. Keep the two rules in step if either changes.
      const docTitle = (msg: string | null): string => {
        // The "🚨 HIGH PRIORITY" marker is a <span> and never wraps the title, so this
        // strip is belt-and-braces — the <strong> match lands correctly either way.
        const cleaned = String(msg || "")
          .replace(/<span[^>]*>[\s\S]*?HIGH PRIORITY[\s\S]*?<\/span>/gi, " ");
        const m = cleaned.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
        return (m ? m[1] : cleaned)
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/&quot;/gi, '"')
          .replace(/&#0?39;|&apos;/gi, "'")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100);
      };

      // Every announcement that ever had a document attached, regardless of age — this
      // feeds the Documents section so files stay available after the post itself has
      // aged off the board. Compact fields only (title, not the message text; no
      // readBy / reactions).
      const documents = annRows
        .filter((a: any) => a.doc_url)
        .map((a: any) => ({
          rowId: a.id,
          date: a.date ? a.date + "T00:00:00" : null,
          author: a.author,
          docUrl: a.doc_url,
          docName: a.doc_name || null,
          title: docTitle(a.message),
          // Removing a file means two different things, and the client has to be
          // able to tell them apart before it asks for confirmation: a doc_only row
          // is deleted outright, while a file attached to a real post is only
          // detached — the post itself is never touched.
          docOnly: !!a.doc_only,
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

    // ── Documents filed on their own, with no post going out ───────────────
    //
    // Stored as an announcements row with doc_only = true, so the Documents view,
    // the storage bucket and the goals/other title matching all keep working
    // unchanged — the row is simply invisible to the board and the feed.
    //
    // The file itself is uploaded to the ann-docs bucket by the client (same path
    // the announcement composer uses); this only records it.
    if (type === "add_document") {
      if (!DOC_ROLES.includes(normRole(body.role))) {
        return json({ success: false, error: "Not authorized to manage documents" }, 403);
      }
      const docUrl = String(body.doc_url || "").trim();
      const docName = String(body.doc_name || "").trim();
      const title = String(body.title || "").trim();
      if (!docUrl || !docName) return json({ success: false, error: "A file is required" }, 400);
      if (!title) return json({ success: false, error: "Give the document a title" }, 400);
      if (title.length > 100) return json({ success: false, error: "Keep the title under 100 characters" }, 400);

      // <strong> because docTitle() reads the first <strong> — the same rule the
      // board uses for an announcement's title. Storing it this way means one
      // title implementation, not two.
      const esc = (s: string) => s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const { data: inserted, error } = await supabase.from("announcements").insert({
        message: `<strong>${esc(title)}</strong>`,
        date: new Date().toISOString().split("T")[0],
        author: body.author || "Executive Team",
        high_priority: false,
        doc_url: docUrl,
        doc_name: docName,
        doc_only: true,
      }).select("id").single();
      if (error) return json({ success: false, error: error.message }, 500);

      await broadcastChange("announcements", null);
      return json({ success: true, id: inserted?.id ?? null });
    }

    // Remove a file from the Documents view. Two very different operations behind
    // one button, decided by what the row actually is:
    //   doc_only  -> the row exists only to hold the file, so delete the row
    //   otherwise -> a real announcement someone posted; clear only the attachment
    //                and leave the post, its reactions and its read receipts alone.
    // The stored object is deliberately NOT deleted: it costs almost nothing to
    // keep, the app never surfaces an orphan, and it makes a mis-click recoverable.
    if (type === "remove_document") {
      if (!DOC_ROLES.includes(normRole(body.role))) {
        return json({ success: false, error: "Not authorized to manage documents" }, 403);
      }
      const id = String(body.rowId || "");
      if (!id) return json({ success: false, error: "Which document?" }, 400);

      const { data: row, error: readErr } = await supabase.from("announcements")
        .select("id, doc_only, doc_url").eq("id", id).single();
      if (readErr || !row) return json({ success: false, error: readErr?.message || "No such document" }, 404);
      if (!row.doc_url) return json({ success: true, id, unchanged: true });

      if (row.doc_only) {
        const { error } = await supabase.from("announcements").delete().eq("id", id);
        if (error) return json({ success: false, error: error.message }, 500);
      } else {
        const { error } = await supabase.from("announcements")
          .update({ doc_url: null, doc_name: null }).eq("id", id);
        if (error) return json({ success: false, error: error.message }, 500);
      }

      await broadcastChange("announcements", null);
      return json({ success: true, id, deletedPost: !!row.doc_only });
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

      await broadcastChange("announcements", null);
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
