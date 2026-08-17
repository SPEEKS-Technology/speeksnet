import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Recycle-out-of-inventory requests. Replaces the old email flow: stores log
// each recycled item here as a line item (SKU / qty / per-unit cost) and the
// DM reconciles per-store cost totals at month end, ticking lines as reviewed.
// Scoped by store, same model as shopify_claims.

function parseMoney(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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
  // The feature_overrides key of the surface this notification is about, so
  // notify can drop anyone whose Feature Access hides it. See notifys
  // featureAllows: the roles above stay the DEFAULT, an override moves an
  // individual either way. Null = no gated surface (an announcement board, a
  // store message) and roles alone are the whole answer.
  audienceFeature?: string | null;
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
      audience_feature: n.audienceFeature ?? null,
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

      // ---- Log a new recycle request ----
      if (action === "submit_request") {
        const store = String(body.store || "").toUpperCase();
        const sku = String(body.sku || "").trim();
        const quantity = Math.floor(Number(body.quantity));
        if (!store || !sku) {
          return jsonResponse({ success: false, error: "Store and SKU are required" }, 400);
        }
        if (!Number.isFinite(quantity) || quantity < 1) {
          return jsonResponse({ success: false, error: "Quantity must be at least 1" }, 400);
        }
        const record = {
          store,
          sku,
          description: body.description ? String(body.description).trim() : null,
          quantity,
          value: parseMoney(body.value), // resale value of the item (optional)
          cost: parseMoney(body.cost),   // store's cost PER UNIT
          created_by: body.created_by ? String(body.created_by).trim() : null,
        };
        const { data, error } = await supabase.from("recycle_requests").insert(record).select().single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", store);
        // Awaiting a verdict from the DM — the review side of the tool.
        await queueNotification({
          category: "requests",
          kind: "recycle_request",
          title: `Recycle request — ${store}`,
          body: `${quantity} × ${sku}${record.description ? ` (${record.description})` : ""} submitted by ${record.created_by || "a store"} and waiting on a verdict.`,
          link: "operations.html",
          store,
          audienceRoles: ["district manager", "ceo"],
          audienceFeature: "tool-recycle-inventory",
          excludeUser: record.created_by,
        });
        return jsonResponse({ success: true, data });
      }

      // ---- DM review: approve/classify a line (or clear the review).
      //      "against" = truly recycled out of inventory, "for" = recycled item
      //      was a tool for store use, "ignore" = cost was consolidated into
      //      another SKU (excluded from cost totals client-side), "denied" =
      //      the DM rejected the request — do NOT recycle the item. Any verdict
      //      other than "denied" reads as approved on the manager's side. ----
      if (action === "set_reviewed") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const reviewed = !!body.reviewed;
        const verdict = ["for", "against", "ignore", "denied"].includes(body.verdict) ? body.verdict : null;
        if (reviewed && !verdict) {
          return jsonResponse({ success: false, error: "Verdict must be 'for', 'against', 'ignore' or 'denied'" }, 400);
        }
        const { data: row, error } = await supabase.from("recycle_requests")
          .update({
            reviewed_at: reviewed ? new Date().toISOString() : null,
            reviewed_by: reviewed ? (body.reviewed_by ? String(body.reviewed_by).trim() : null) : null,
            review_verdict: reviewed ? verdict : null,
          })
          .eq("id", id).select("store, sku, quantity, created_by").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        // The verdict is the answer the store has been waiting on, so it goes back
        // down to them. CLEARING a review (reviewed=false) is the DM undoing their
        // own click, not news — stay silent, or an accidental double-click emails
        // the store twice about nothing.
        if (reviewed && row?.store) {
          const st = String(row.store).toUpperCase();
          const line = `${row.quantity} × ${row.sku}`;
          await queueNotification({
            category: "requests",
            kind: "recycle_verdict",
            title: verdict === "denied"
              ? `Recycle request denied — ${st}`
              : `Recycle request approved — ${st}`,
            body: verdict === "denied"
              ? `${line} was not approved. Do not recycle the item.`
              : `${line} was approved${verdict === "for" ? " as a tool for store use" : ""}.`,
            link: "operations.html",
            store: st,
            audienceStores: [st],
            audienceRoles: ["manager", "owner (manager)", "assistant manager"],
            audienceFeature: "tool-recycle-inventory",
            excludeUser: body.reviewed_by ? String(body.reviewed_by).trim() : null,
          });
        }
        return jsonResponse({ success: true });
      }

      // ---- DM note on a line (empty note clears it). The note timestamp also
      //      drives the manager-side "new activity" alert. ----
      if (action === "save_dm_note") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const note = body.note ? String(body.note).trim() : "";
        const { data: dmRow, error } = await supabase.from("recycle_requests")
          .update({
            dm_note: note || null,
            dm_note_by: note ? (body.by ? String(body.by).trim() : null) : null,
            dm_note_at: note ? new Date().toISOString() : null,
          })
          .eq("id", id).select("store").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        // Legacy single-field path — the note UI posts add_note instead, so in
        // practice this does not fire. Kept in step with add_note so that if
        // anything ever does call it the store still hears about the note. Only a
        // real note is news; clearing one lands here too and must stay silent.
        if (note && dmRow?.store) {
          const st = String(dmRow.store).toUpperCase();
          await queueNotification({
            category: "requests",
            kind: "recycle_dm_note",
            title: `Recycle note from the DM — ${st}`,
            body: note.slice(0, 300),
            link: "operations.html",
            store: st,
            audienceStores: [st],
            audienceRoles: ["manager", "owner (manager)", "assistant manager"],
            audienceFeature: "tool-recycle-inventory",
            excludeUser: body.by ? String(body.by).trim() : null,
          });
        }
        return jsonResponse({ success: true });
      }

      // ---- Append a note to a line's back-and-forth thread (DM or manager).
      //      Notes are never overwritten: each message is a thread entry. The
      //      latest message per side is mirrored into dm_note*/mgr_reply* so
      //      the alert logic (dm_note_at / mgr_reply_at) keeps working. ----
      if (action === "add_note") {
        const id = String(body.id || "");
        const text = body.text ? String(body.text).trim() : "";
        const role = body.role === "dm" ? "dm" : "mgr";
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        if (!text) return jsonResponse({ success: false, error: "Empty note" }, 400);
        const { data: row, error: selErr } = await supabase.from("recycle_requests")
          .select("note_thread, store, sku, quantity").eq("id", id).single();
        if (selErr) return jsonResponse({ success: false, error: selErr.message }, 500);
        const thread = Array.isArray(row?.note_thread) ? row.note_thread : [];
        const at = new Date().toISOString();
        const by = body.by ? String(body.by).trim() : null;
        thread.push({ role, text, by, at });
        const patch: Record<string, unknown> = { note_thread: thread };
        if (role === "dm") { patch.dm_note = text; patch.dm_note_by = by; patch.dm_note_at = at; }
        else { patch.mgr_reply = text; patch.mgr_reply_by = by; patch.mgr_reply_at = at; }
        const { error } = await supabase.from("recycle_requests").update(patch).eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        // THIS is the path the tool actually uses for both sides of the thread —
        // the note UI posts add_note, never save_dm_note / save_mgr_reply. Those two
        // older single-field actions keep their own hooks below in case anything
        // still calls them, but a hook here is the one that fires in practice.
        {
          const st = row?.store ? String(row.store).toUpperCase() : null;
          const line = row?.sku ? `${row.quantity} × ${row.sku}` : null;
          await queueNotification({
            category: "requests",
            kind: role === "dm" ? "recycle_dm_note" : "recycle_reply",
            title: role === "dm"
              ? `Recycle note from the DM${st ? ` — ${st}` : ""}`
              : `Recycle reply from ${by || "a manager"}${st ? ` — ${st}` : ""}`,
            body: [line, text].filter(Boolean).join(" — ").slice(0, 300),
            link: "operations.html",
            store: st,
            // A DM note is for the store that raised it; a manager's reply goes back
            // up to the corp side, which is not store-scoped.
            audienceStores: role === "dm" && st ? [st] : null,
            audienceRoles: role === "dm"
              ? ["manager", "owner (manager)", "assistant manager"]
              : ["district manager", "ceo"],
            audienceFeature: "tool-recycle-inventory",
            excludeUser: by,
          });
        }
        return jsonResponse({ success: true, entry: { role, text, by, at } });
      }

      // ---- Manager replies to the DM's note (empty reply clears it). The
      //      reply timestamp drives the DM-side "manager replied" alert. ----
      if (action === "save_mgr_reply") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const reply = body.reply ? String(body.reply).trim() : "";
        const { error } = await supabase.from("recycle_requests")
          .update({
            mgr_reply: reply || null,
            mgr_reply_by: reply ? (body.by ? String(body.by).trim() : null) : null,
            mgr_reply_at: reply ? new Date().toISOString() : null,
          })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        // Only a real reply is news. Clearing one (empty string) also lands here
        // and must stay silent, or deleting a note would read as writing one.
        if (reply) {
          await queueNotification({
            category: "requests",
            kind: "recycle_reply",
            title: "Recycle reply from a manager",
            body: reply.slice(0, 300),
            link: "operations.html",
            audienceRoles: ["district manager", "ceo"],
            audienceFeature: "tool-recycle-inventory",
            excludeUser: body.by ? String(body.by).trim() : null,
          });
        }
        return jsonResponse({ success: true });
      }

      // ---- Viewer opened their requests: stamp the lines as seen so the
      //      NEW dots / alerts stop for them. role 'dm' stamps the DM's side;
      //      anything else stamps the manager's (backward compatible). ----
      if (action === "mark_seen") {
        const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)).filter(Boolean) : [];
        if (!ids.length) return jsonResponse({ success: true });
        const patch = body.role === "dm"
          ? { dm_seen_at: new Date().toISOString() }
          : { manager_seen_at: new Date().toISOString() };
        const { error } = await supabase.from("recycle_requests")
          .update(patch)
          .in("id", ids);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Manager asks for a line to be removed. Nothing is deleted here —
      //      the flag puts it in the DM/CEO approval queue (same model as the
      //      insurance-claims delete requests). ----
      if (action === "request_delete") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const who = body.requested_by ? String(body.requested_by).trim() : null;
        // .select() so the notification can name the line — see the twin of this
        // hook in shopify-claims for why this is filed under `requests`.
        const { data: line, error } = await supabase.from("recycle_requests")
          .update({
            delete_requested_at: new Date().toISOString(),
            delete_requested_by: who,
          })
          .eq("id", id)
          .select("store, sku, description").maybeSingle();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        // District Manager only, for the same reason as the claims delete request.
        {
          const store = String(line?.store || "").toUpperCase();
          const sku = String(line?.sku || "").trim();
          const desc = String(line?.description || "").trim();
          await queueNotification({
            category: "requests",
            kind: "recycle_delete_request",
            title: `Delete request — recycle line${store ? ` — ${store}` : ""}`,
            body: `${who || "A manager"} asked to delete ${sku || "a line"}${desc ? ` (${desc})` : ""}. Nothing is removed until you approve it.`,
            link: "operations.html",
            store: store || null,
            audienceRoles: ["district manager"],
            audienceFeature: "tool-recycle-inventory",
            excludeUser: who,
          });
        }
        return jsonResponse({ success: true });
      }

      // ---- DM/CEO denies a pending delete request: keep the line, clear the flag. ----
      if (action === "deny_delete") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("recycle_requests")
          .update({ delete_requested_at: null, delete_requested_by: null })
          .eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true });
      }

      // ---- Actually delete a line — DM/CEO only (frontend-gated): directly
      //      via their trash button, or by approving a manager's request. ----
      if (action === "delete_request") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("recycle_requests").delete().eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("recycle", null);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET: list requests for the requested store(s); no stores param = all
  //      stores (DM/CEO oversight). Month bucketing happens client-side; cap
  //      the window server-side so the payload stays bounded as history grows. ----
  const url = new URL(req.url);
  const storesParam = url.searchParams.get("stores") || url.searchParams.get("store") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const since = new Date();
  since.setUTCDate(1);
  since.setUTCMonth(since.getUTCMonth() - 12); // current month + 12 prior
  let query = supabase.from("recycle_requests").select("*")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false });
  if (stores.length) query = query.in("store", stores);

  const { data, error } = await query;
  if (error) return jsonResponse({ success: false, error: error.message }, 500);
  return jsonResponse({ success: true, data: data || [] });
});
