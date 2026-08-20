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

// Normalize "m/d/yyyy" (legacy client format) to ISO "yyyy-mm-dd". Pass through anything already ISO.
function toISODate(d: string): string {
  if (!d) return d;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return d;
}

const titleCaseName = (n: unknown) => String(n ?? "").trim()
  .split(/\s+/)
  .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w)
  .join(" ");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // PostgREST caps a response at 1000 rows and does not say so — the same
  // silence that lost 954 announcement read receipts from the usage report.
  // patch_note_read_log gains roughly a row per person per release, so it will
  // cross that line within the year.
  const allRows = async (table: string, cols: string) => {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
      if (error) return out;
      const rows = data || [];
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  };

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

    // WHO HAS READ EACH RELEASE, for the same eye-icon control the
    // announcements board shows the DM and the CEO. Keyed by version rather
    // than by item: a release is several rows sharing a title and a date.
    //
    // Returned to everyone and gated in the UI, exactly as cms does it — the
    // two boards behaving differently about the same question would be a
    // second rule to remember.
    const logRows = await allRows("patch_note_read_log", "version_key, user_name");
    const { data: userRows } = await supabase.from("users").select("name");
    // The log stores names lowercased; show them the way they are spelled.
    const properName = new Map<string, string>();
    for (const u of (userRows || [])) {
      properName.set(String(u.name).trim().toLowerCase(), String(u.name));
    }
    const readsByVersion: Record<string, string[]> = {};
    for (const r of logRows) {
      const key = String(r.version_key);
      if (!readsByVersion[key]) readsByVersion[key] = [];
      const who = String(r.user_name || "").trim().toLowerCase();
      // Somebody who has left is no longer in `users`, so there is no spelling to
      // look up — they would otherwise be listed as "matt campbell" beside
      // "Garrett Burnell", which reads as a bug rather than as an ex-employee.
      readsByVersion[key].push(properName.get(who) || titleCaseName(r.user_name));
    }
    for (const k of Object.keys(readsByVersion)) {
      readsByVersion[k].sort((a: string, b: string) => a.localeCompare(b));
    }

    return json({ entries, reads: readsByVersion });
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    // Mark a user's patch notes as read.
    //
    // TWO RECORDS, ON PURPOSE, ANSWERING DIFFERENT QUESTIONS.
    // patch_note_reads is a watermark — one row per person, overwritten — and it
    // is the right shape for the unread badge ("anything newer than v3.2.0?").
    // It is the wrong shape for the usage report, because a later read erases
    // the earlier one: re-running the report for the 11th found nothing and
    // said nobody read it. patch_note_read_log keeps one row per person per
    // version, the way announcement_reads does, so a read stays true afterwards.
    if (body.action === "markPatchRead" && body.user && body.lastSeenKey) {
      const who = String(body.user).toLowerCase().trim();
      const newKey = String(body.lastSeenKey);

      const { data: prev } = await supabase
        .from("patch_note_reads").select("last_seen_key")
        .eq("user_name", who).limit(1);
      const oldKey = prev?.[0]?.last_seen_key || null;

      // Newest first, the order the panel lists them in. One key per release,
      // not per item: a release is several patch_notes rows sharing a title and
      // a date, and nobody reads an individual line of a changelog.
      const { data: notes } = await supabase
        .from("patch_notes").select("title, date").order("date", { ascending: false });
      const keys: string[] = [];
      for (const n of (notes || [])) {
        const k = `${n.title}|${n.date}`;
        if (!keys.includes(k)) keys.push(k);
      }

      const iNew = keys.indexOf(newKey);
      const iOld = oldKey ? keys.indexOf(oldKey) : -1;
      // keys is newest-first, so "newer than the old watermark" is a LOWER index.
      //
      // A FIRST-EVER READ LOGS ONLY THE NEWEST VERSION. Somebody pressing the
      // button for the first time has not read ten weeks of history, and
      // crediting them with it would have the report overstate the one thing
      // these receipts exist to measure honestly.
      const fresh = iNew < 0 ? [newKey]
        : iOld < 0 ? [keys[iNew]]
        : keys.slice(iNew, iOld);

      if (fresh.length) {
        // ignoreDuplicates so pressing the button again never rewrites read_at.
        // When somebody first read a version is the fact being recorded; moving
        // that timestamp forward would quietly relabel an old read as a new one
        // and drag it into a report period it does not belong to.
        await supabase.from("patch_note_read_log").upsert(
          fresh.map((k: string) => ({ version_key: k, user_name: who })),
          { onConflict: "version_key,user_name", ignoreDuplicates: true },
        );
      }

      await supabase.from("patch_note_reads").upsert({
        user_name: who,
        last_seen_key: newKey,
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

        // A release goes to everybody. Only addEntries queues mail — editGroup,
        // editEntry and deleteEntry below all broadcast too, but fixing a typo in
        // a published note is not news and must not re-mail the company.
        const ver = String(body.title || "").trim();
        const cats = [...new Set(rows.map((r: any) => String(r.category)))];
        await queueNotification({
          category: "announcements",
          kind: "patch_notes",
          title: `New patch notes${ver ? ` — ${ver.replace(/^\s*v/i, "v")}` : ""}`,
          body: `${rows.length} change${rows.length === 1 ? "" : "s"} shipped${cats.length ? ` across ${cats.join(", ")}` : ""}.`,
          link: "index.html",
          // The person who wrote the release does not need mailing about it.
          // Every other notification in the system already excludes its author;
          // this one had no exclusion at all, so the author was told about their
          // own patch notes and then had to mark them read.
          excludeUser: body.submittedBy ? String(body.submittedBy).trim() : null,
        });
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
