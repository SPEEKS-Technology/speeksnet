import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Preferred Purchases. Managers / ASMs / the DM suggest products; the Owner
// (Manager) approves what earns a place on the shared Amazon list.
//
// Pipeline only: this is the record of decisions, NOT a mirror of the list —
// the list itself lives on Amazon. That is why there is no category and no
// per-store scope; one shared list can express neither.
//
// Table is RLS-on with zero policies, so every read and write goes through
// here on the service role. Role gating is done in the frontend, matching the
// other tools; the one thing enforced server-side is ownership (you can only
// edit or withdraw your own request, and only while it is still pending),
// because that is a rule the UI alone cannot be trusted to keep.

const TABLE = "preferred_purchase_requests";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseMoney(v: unknown): number | null {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function s(v: unknown, max = 400): string {
  return String(v ?? "").trim().slice(0, max);
}

// Only http(s) links are accepted. A javascript: or data: URL would end up in
// an href on the owner's queue, so this is a real gate, not tidiness.
function cleanUrl(v: unknown): string | null {
  const raw = s(v, 2000);
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.toString();
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ------------------------------------------------------------------ READ
  if (req.method === "GET") {
    try {
      const url = new URL(req.url);
      const scope = (url.searchParams.get("scope") || "mine").toLowerCase();
      const who = s(url.searchParams.get("name"), 120).toLowerCase();

      let q = supabase.from(TABLE).select("*");
      if (scope === "mine") {
        // A requester only ever sees their own. Without a name there is
        // nothing to scope to, so return empty rather than everything.
        if (!who) return jsonResponse({ success: true, requests: [] });
        q = q.ilike("requested_by", who);
      }
      // scope=all is the owner's queue + history (frontend-gated).

      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      return jsonResponse({ success: true, requests: data || [] });
    } catch (e) {
      return jsonResponse({ success: false, error: String(e) }, 500);
    }
  }

  // ----------------------------------------------------------------- WRITE
  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const action = body.action;

      // ---- Someone suggests a product ----
      if (action === "submit_request") {
        const item_name = s(body.item_name, 200);
        const link = cleanUrl(body.url);
        const reason = s(body.reason, 2000);
        const requested_by = s(body.requested_by, 120);
        if (!item_name)    return jsonResponse({ success: false, error: "Item name is required." }, 400);
        if (!link)         return jsonResponse({ success: false, error: "A valid http(s) product link is required." }, 400);
        if (!reason)       return jsonResponse({ success: false, error: "A reason is required." }, 400);
        if (!requested_by) return jsonResponse({ success: false, error: "Missing requester." }, 400);

        const store = s(body.store, 12).toUpperCase() || null;
        const { data, error } = await supabase.from(TABLE).insert({
          item_name,
          url: link,
          price: parseMoney(body.price),
          pack_size: s(body.pack_size, 120) || null,
          reason,
          requested_by,
          requested_by_role: s(body.requested_by_role, 60) || null,
          store,
        }).select("id").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);

        await broadcastChange("preferred", store);
        return jsonResponse({ success: true, id: data?.id ?? null });
      }

      // ---- Owner approves or denies ----
      if (action === "decide") {
        const id = Number(body.id);
        const verdict = s(body.verdict, 20).toLowerCase();
        if (!Number.isFinite(id))                          return jsonResponse({ success: false, error: "Bad id." }, 400);
        if (verdict !== "approved" && verdict !== "denied") return jsonResponse({ success: false, error: "Verdict must be approved or denied." }, 400);

        const { data, error } = await supabase.from(TABLE).update({
          status: verdict,
          decided_at: new Date().toISOString(),
          decided_by: s(body.decided_by, 120) || null,
          owner_note: s(body.owner_note, 2000) || null,
          // A fresh decision is unseen news for the requester, so clear any
          // previous stamp — otherwise a re-decided request would never nag.
          requester_seen_at: null,
        }).eq("id", id).select("store").maybeSingle();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);

        await broadcastChange("preferred", data?.store ?? null);
        return jsonResponse({ success: true });
      }

      // ---- Requester fixes their own request, while it is still pending ----
      if (action === "edit_request") {
        const id = Number(body.id);
        const by = s(body.by, 120).toLowerCase();
        if (!Number.isFinite(id)) return jsonResponse({ success: false, error: "Bad id." }, 400);
        if (!by)                  return jsonResponse({ success: false, error: "Missing user." }, 400);

        const { data: row } = await supabase.from(TABLE)
          .select("id, status, requested_by").eq("id", id).maybeSingle();
        if (!row)                     return jsonResponse({ success: false, error: "Request not found." }, 404);
        if (row.status !== "pending") return jsonResponse({ success: false, error: "That request has already been decided." }, 409);
        if (String(row.requested_by || "").toLowerCase() !== by) {
          return jsonResponse({ success: false, error: "You can only edit your own request." }, 403);
        }

        const patch: Record<string, unknown> = {};
        if (body.item_name !== undefined) {
          const v = s(body.item_name, 200);
          if (!v) return jsonResponse({ success: false, error: "Item name is required." }, 400);
          patch.item_name = v;
        }
        if (body.url !== undefined) {
          const v = cleanUrl(body.url);
          if (!v) return jsonResponse({ success: false, error: "A valid http(s) product link is required." }, 400);
          patch.url = v;
        }
        if (body.reason !== undefined) {
          const v = s(body.reason, 2000);
          if (!v) return jsonResponse({ success: false, error: "A reason is required." }, 400);
          patch.reason = v;
        }
        if (body.price !== undefined)     patch.price = parseMoney(body.price);
        if (body.pack_size !== undefined) patch.pack_size = s(body.pack_size, 120) || null;
        if (!Object.keys(patch).length)   return jsonResponse({ success: false, error: "Nothing to change." }, 400);

        const { data, error } = await supabase.from(TABLE)
          .update(patch).eq("id", id).select("store").maybeSingle();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);

        await broadcastChange("preferred", data?.store ?? null);
        return jsonResponse({ success: true });
      }

      // ---- Requester pulls their own pending request ----
      if (action === "withdraw_request") {
        const id = Number(body.id);
        const by = s(body.by, 120).toLowerCase();
        if (!Number.isFinite(id)) return jsonResponse({ success: false, error: "Bad id." }, 400);

        const { data: row } = await supabase.from(TABLE)
          .select("id, status, requested_by, store").eq("id", id).maybeSingle();
        if (!row) return jsonResponse({ success: true });   // already gone
        // The owner can remove anything; a requester only their own pending row.
        const isOwner = !!body.as_owner;
        if (!isOwner) {
          if (row.status !== "pending") return jsonResponse({ success: false, error: "That request has already been decided." }, 409);
          if (String(row.requested_by || "").toLowerCase() !== by) {
            return jsonResponse({ success: false, error: "You can only withdraw your own request." }, 403);
          }
        }

        const { error } = await supabase.from(TABLE).delete().eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);

        await broadcastChange("preferred", row.store ?? null);
        return jsonResponse({ success: true });
      }

      // ---- Requester has seen their verdicts (clears their feed card) ----
      // Deliberately does NOT broadcast: a read receipt is not news to anyone,
      // and pinging here would make every other client re-fetch for nothing.
      if (action === "mark_seen") {
        const who = s(body.name, 120).toLowerCase();
        if (!who) return jsonResponse({ success: false, error: "Missing user." }, 400);
        const { error } = await supabase.from(TABLE)
          .update({ requester_seen_at: new Date().toISOString() })
          .ilike("requested_by", who)
          .not("decided_at", "is", null)
          .is("requester_seen_at", null);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action." }, 400);
    } catch (e) {
      return jsonResponse({ success: false, error: String(e) }, 500);
    }
  }

  return jsonResponse({ success: false, error: "Method not allowed." }, 405);
});
