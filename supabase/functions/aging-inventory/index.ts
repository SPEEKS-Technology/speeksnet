import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Aging Inventory. Each week the DM hand-picks the most valuable 30-day-plus
// items from the POS and adds them here with an opening note (what to fix or
// answer on the listing). The store (manager/ASM) has a week to reply; the DM
// can keep following up (each DM note restarts the week clock) until the item
// sells (green) or gets recycled out (red). Notes are an unlimited alternating
// thread per item. Tables: aging_items + aging_notes.

const STORE_REPLY_DAYS = 7; // the store gets a week from every DM note

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseNum(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function replyDue(): string {
  const d = new Date();
  d.setDate(d.getDate() + STORE_REPLY_DAYS);
  return d.toISOString();
}

// Realtime "ping": after a successful write, tell any signed-in client that this
// tool changed so it can re-run its check (which re-fetches through THIS function
// — no table data ever travels over realtime, so the RLS-locked tables stay
// closed to the anon client). The store is a hint for client-side filtering.
// Wrapped so a broadcast failure can never break the write it follows.
async function broadcastChange(tool: string, store: string | null) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        messages: [{
          topic: "speeks-notify",
          event: "changed",
          payload: { tool, store: store ? String(store).toUpperCase() : null, ts: Date.now() },
        }],
      }),
    });
  } catch (_) {
    // swallow — the write already succeeded; realtime is best-effort
  }
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const action = body.action;

      // ---- DM adds an item, with an optional opening note ----
      // (The DM often quick-adds the week's items back-to-back and posts the
      // notes into each thread afterwards, so the note may come later.)
      if (action === "add_item") {
        const store = String(body.store || "").toUpperCase();
        const note = String(body.note || "").trim();
        if (!store) return jsonResponse({ success: false, error: "store is required" }, 400);
        const by = body.by ? String(body.by).trim() : null;
        const { data: item, error: iErr } = await supabase.from("aging_items").insert({
          store,
          sku: body.sku ? String(body.sku).trim() : null,
          title: body.title ? String(body.title).trim() : null,
          date_created: body.date_created ? String(body.date_created) : null,
          est_value: parseNum(body.est_value),
          cost: parseNum(body.cost),
          created_by: by,
          due_at: replyDue(),
        }).select().single();
        if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);
        if (note) {
          const { error: nErr } = await supabase.from("aging_notes").insert({
            item_id: item.id, author_name: by, author_side: "dm", body: note,
          });
          if (nErr) {
            // don't leave a half-created item behind
            await supabase.from("aging_items").delete().eq("id", item.id);
            return jsonResponse({ success: false, error: nErr.message }, 500);
          }
        }
        await broadcastChange("aging", store);
        // A new aging item starts the store's one-week reply clock (due_at above),
        // so the store hears about it as soon as it is added rather than when the
        // clock has already run down.
        await queueNotification({
          category: "variance_aging",
          kind: "aging_item_added",
          title: `Aging inventory added — ${store}`,
          body: [item.sku, item.title].filter(Boolean).join(" · ").slice(0, 200) ||
                "An item has been added for review, with a reply due within a week.",
          link: "workspace.html#aging",
          store,
          audienceStores: [store],
          audienceRoles: ["manager", "owner (manager)", "assistant manager"],
          excludeUser: by,
        });
        return jsonResponse({ success: true, item_id: item.id });
      }

      // ---- Either side appends to an item's note thread ----
      if (action === "add_note") {
        const itemId = String(body.item_id || "");
        const side = String(body.side || "");
        const text = String(body.body || "").trim();
        if (!itemId || !text || (side !== "dm" && side !== "store")) {
          return jsonResponse({ success: false, error: "item_id, side (dm|store) and body are required" }, 400);
        }
        const { data: item, error: gErr } = await supabase.from("aging_items")
          .select("id, status, store").eq("id", itemId).maybeSingle();
        if (gErr) return jsonResponse({ success: false, error: gErr.message }, 500);
        if (!item) return jsonResponse({ success: false, error: "Item not found" }, 404);
        if (item.status !== "open") {
          return jsonResponse({ success: false, error: "This item is closed" }, 400);
        }
        const { data: note, error: nErr } = await supabase.from("aging_notes").insert({
          item_id: itemId,
          author_name: body.by ? String(body.by).trim() : null,
          author_side: side,
          body: text,
        }).select().single();
        if (nErr) return jsonResponse({ success: false, error: nErr.message }, 500);
        // A DM note (opening or follow-up) restarts the store's one-week clock.
        // It also puts the ball back in the store's court, so anything the DM had
        // pending on this item is answered — stamp it seen so the review queue
        // does not keep listing an item the DM has just replied to.
        if (side === "dm") {
          await supabase.from("aging_items")
            .update({ due_at: replyDue(), dm_seen_at: new Date().toISOString() })
            .eq("id", itemId);
        }
        await broadcastChange("aging", item.store);
        // The thread has two sides and the email follows whichever way it just
        // moved: a DM note goes to the store, a store note goes back to the DM.
        // `side` is already validated to one of the two above.
        {
          const toStore = side === "dm";
          const st = String(item.store || "").toUpperCase();
          await queueNotification({
            category: "variance_aging",
            kind: toStore ? "aging_dm_note" : "aging_store_reply",
            title: toStore
              ? `Aging inventory note from the DM — ${st}`
              : `Aging inventory reply from ${body.by ? String(body.by).trim() : "the store"} — ${st}`,
            body: text.slice(0, 300),
            link: "workspace.html#aging",
            store: st,
            audienceStores: toStore ? [st] : null,
            audienceRoles: toStore
              ? ["manager", "owner (manager)", "assistant manager"]
              : ["district manager", "ceo"],
            excludeUser: body.by ? String(body.by).trim() : null,
          });
        }
        return jsonResponse({ success: true, note_id: note.id });
      }

      // ---- DM closes (sold/recycled) or reopens an item ----
      if (action === "set_status") {
        const itemId = String(body.item_id || "");
        const status = String(body.status || "");
        if (!itemId || !["open", "sold", "recycled"].includes(status)) {
          return jsonResponse({ success: false, error: "item_id and status (open|sold|recycled) required" }, 400);
        }
        const closed = status !== "open";
        const { data: row, error } = await supabase.from("aging_items").update({
          status,
          closed_by: closed ? (body.by ? String(body.by).trim() : null) : null,
          closed_at: closed ? new Date().toISOString() : null,
        }).eq("id", itemId).select("store").maybeSingle();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("aging", row?.store ?? null);
        return jsonResponse({ success: true });
      }

      // ---- DM edits one of their own notes (typo fix; the row-edit mode
      // only exposes DM-side notes as editable, so no side check needed) ----
      if (action === "update_note") {
        const noteId = String(body.note_id || "");
        const text = String(body.body || "").trim();
        if (!noteId || !text) return jsonResponse({ success: false, error: "note_id and body required" }, 400);
        const by = body.by ? String(body.by).trim() : null;
        const { data: note, error } = await supabase.from("aging_notes")
          .update({ body: text, edited_by: by, edited_at: new Date().toISOString() })
          .eq("id", noteId).select("edited_at").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("aging", null); // store not looked up for a typo edit
        return jsonResponse({ success: true, edited_at: note?.edited_at });
      }

      // ---- DM fixes a typo in the item fields ----
      if (action === "update_item") {
        const itemId = String(body.item_id || "");
        if (!itemId) return jsonResponse({ success: false, error: "item_id required" }, 400);
        const patch: Record<string, unknown> = {};
        if ("sku" in body) patch.sku = body.sku ? String(body.sku).trim() : null;
        if ("title" in body) patch.title = body.title ? String(body.title).trim() : null;
        if ("date_created" in body) patch.date_created = body.date_created ? String(body.date_created) : null;
        if ("est_value" in body) patch.est_value = parseNum(body.est_value);
        if ("cost" in body) patch.cost = parseNum(body.cost);
        if (!Object.keys(patch).length) return jsonResponse({ success: false, error: "Nothing to update" }, 400);
        const { data: row, error } = await supabase.from("aging_items").update(patch).eq("id", itemId).select("store").maybeSingle();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("aging", row?.store ?? null);
        return jsonResponse({ success: true });
      }

      // ---- DM opened the tool: stamp the items they just looked at ----
      // The DM answering a store reply is optional. If they read it and it needs
      // nothing more, the item is parked until it sells or they follow up — so
      // "the store replied last" cannot mean "your review" forever. The review
      // queue is store-replies-newer-than-this-stamp, which means looking is what
      // clears it, and only a genuinely new reply brings the item back.
      // No broadcast: this is a read receipt, not a change other clients care
      // about, and pinging here would bounce every open session on every open.
      if (action === "mark_dm_seen") {
        const ids: string[] = Array.isArray(body.ids)
          ? body.ids.map((v: unknown) => String(v)).filter(Boolean) : [];
        if (!ids.length) return jsonResponse({ success: true, updated: 0 });
        const seenAt = new Date().toISOString();
        const { error } = await supabase.from("aging_items")
          .update({ dm_seen_at: seenAt }).in("id", ids);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true, updated: ids.length, dm_seen_at: seenAt });
      }

      // ---- DM deletes an item added by mistake (notes cascade) ----
      if (action === "delete_item") {
        const itemId = String(body.item_id || "");
        if (!itemId) return jsonResponse({ success: false, error: "item_id required" }, 400);
        const { data: row, error } = await supabase.from("aging_items").delete().eq("id", itemId).select("store").maybeSingle();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("aging", row?.store ?? null);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET [?stores=A,B] → items with their full note threads ----
  // Open items always; closed ones only from the last 45 days (they stay
  // visible in the tab's "closed" section for a while, then age out of the
  // payload — keeps egress flat as history accumulates).
  const url = new URL(req.url);
  const storesParam = url.searchParams.get("stores") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const closedCutoff = new Date(Date.now() - 45 * 86400000).toISOString();

  let q = supabase.from("aging_items").select("*")
    .or(`status.eq.open,closed_at.gt.${closedCutoff}`)
    .order("created_at", { ascending: false })
    .limit(400);
  if (stores.length) q = q.in("store", stores);
  const { data: items, error: iErr } = await q;
  if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);

  const ids = (items || []).map((it: any) => it.id);
  const notesByItem: Record<string, any[]> = {};
  if (ids.length) {
    const { data: notes, error: nErr } = await supabase.from("aging_notes")
      .select("*").in("item_id", ids).order("created_at", { ascending: true });
    if (nErr) return jsonResponse({ success: false, error: nErr.message }, 500);
    (notes || []).forEach((n: any) => {
      (notesByItem[n.item_id] = notesByItem[n.item_id] || []).push(n);
    });
  }
  const data = (items || []).map((it: any) => ({ ...it, notes: notesByItem[it.id] || [] }));
  return jsonResponse({ success: true, data });
});
