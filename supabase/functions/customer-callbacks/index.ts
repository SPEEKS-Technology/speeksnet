// ============================================================================
// customer-callbacks — the Call Back sheet's backend.
//
// RECOVERED FROM THE DEPLOYED FUNCTION, 2026-08-21. This ran in production from
// 2026-07-02 with no source in the repository, so there was nothing to edit and
// nothing to review. Pulled back down byte-for-byte before touching it.
//
// Seventeen functions were in that state. If you are here to change one of the
// others, fetch it the same way rather than reconstructing it from the UI.
//
// EXTENDED 2026-08-21 for Shopify matching (see `callback-match`):
//
//   GET  ?vocab=1              the Category → Type vocabulary for the quick-add
//   GET  ?view=active&store=X  entries, each carrying its `matches`
//   POST match_confirm / match_reject
//
// Three fields join a call back to the catalogue: `category_handle` (a Shopify
// collection — the matcher's gate, so a row without one can never match),
// `type_id` and `any_model`. `needs_detail` is computed here, once, on write.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STORES = new Set(["OVL", "LEE", "WSP", "MPL", "BAL"]);
const MSM_STORES = new Set(["BAL", "MPL"]);
// 'tom' was in this list and is not a role anybody holds; 'mocd' IS one and was
// missing, so the MOCD could create a call back for another store in the UI and
// be refused by the server. Kept in step with CB_CORP_ROLES in speeks.js.
const CORP_ROLES = new Set(["district manager", "ceo", "mocd"]);
// Who may answer a match. The store that HAS the item decides, because they are
// the ones who would ring the customer and sell it.
const DECIDER_ROLES = new Set([
  "manager", "assistant manager", "multi-store manager", "owner (manager)",
]);
// WHO MAY DELETE. A delete takes the customer's request and its whole note
// thread with it, and there is no undo — a different weight of action from
// editing a phone number, so a different list from canModify. An ASM or below
// posts `delete_request` instead, which lands in the note thread.
// Mirrored by CB_DELETE_ROLES in speeks.js; THIS is what enforces it.
const DELETE_ROLES = new Set([
  "manager", "owner (manager)", "owner manager", "multi-store manager",
  "district manager", "ceo", "mocd",
]);
const STATUSES = new Set(["open", "contacted", "completed"]);
const MATCH_STATES = new Set(["suggested", "confirmed", "rejected", "sold"]);

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const MATCH_SECRET = "sp33ks-sync-k3y-2026-x9mq";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function todayCentral(): string {
  // YYYY-MM-DD for America/Chicago
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

// Role gate mirrors cbCanModify in speeks.js: edit/delete/restore are scoped to
// the caller's own store; the MSM (role 'manager' + multi flag) covers BAL+MPL;
// corp roles cover everything. Status changes and notes are deliberately NOT
// gated — any store acting on a callback is the cross-store signal.
function canModify(entryStore: string, role: string, store: string, multi: boolean): boolean {
  const r = (role || "").toLowerCase().trim();
  const s = (store || "").toUpperCase();
  if (CORP_ROLES.has(r) || s === "ALL") return true;
  if (multi && MSM_STORES.has(entryStore)) return true;
  return entryStore === s;
}

// Is this person management OF THAT STORE. Called twice for a match — once for the
// store holding the item, once for the store that logged the customer — because
// either of them may veto a pairing. An employee can see the green row and ring
// the customer; a permanent change to what the sweep offers needs a manager.
function canDecideMatch(holdingStore: string, role: string, store: string, multi: boolean): boolean {
  const r = (role || "").toLowerCase().trim();
  const s = (store || "").toUpperCase();
  if (CORP_ROLES.has(r) || s === "ALL") return true;
  if (!DECIDER_ROLES.has(r)) return false;
  if (multi && MSM_STORES.has(holdingStore)) return true;
  return holdingStore === s;
}

// --- "did they actually name anything?" -------------------------------------
// The red Needs Detail tag. A row is unmatchable when the customer's own words
// contain nothing specific AND nothing else narrows it: no Any Model, and a type
// that is only a shelf ("Controller", "Sony PlayStation 3") or no type at all.
//
// This is a statement about the ROW, not about the catalogue, which is why it
// lives here and not in the matcher. The stopword set below is a deliberately
// coarser, independent copy of the matcher's NOISE + SHELF sets — a tag that is
// slightly too eager is cosmetic, whereas a match that is wrong is not, so the
// two are allowed to disagree at the edges rather than be wired together.
const VAGUE = new Set([
  "new", "used", "like", "open", "box", "sealed", "any", "cheap", "good", "best",
  "for", "and", "the", "with", "only", "not", "in", "of", "to", "or", "one",
  "video", "game", "games", "gaming", "console", "player", "system", "systems",
  "phone", "cell", "tablet", "laptop", "computer", "camera", "lens", "charger",
  "cable", "controller", "headset", "monitor", "speaker", "watch", "card",
  "prefer", "prefers", "wants", "want", "wanted", "looking", "please", "call",
  "back", "customer", "asap", "soon", "budget", "under", "about", "around",
]);

function saidSomethingSpecific(item: string): boolean {
  return String(item || "")
    .toLowerCase().replace(/[^a-z0-9#/+.\- ]+/g, " ").split(/\s+/)
    .some((t) => t.length >= 3 && !VAGUE.has(t) && !/^\d{1,2}$/.test(t)
      && (/\d/.test(t) || t.length >= 4));
}

async function computeNeedsDetail(
  supabase: any, item: string, typeId: number | null, anyModel: boolean,
): Promise<boolean> {
  if (anyModel) return false;
  if (saidSomethingSpecific(item)) return false;
  if (!typeId) return true;                 // no type and nothing said: unmatchable
  const { data } = await supabase
    .from("callback_types").select("needs_item_text").eq("id", typeId).maybeSingle();
  // A type that IS the model ("iPhone 15") answers on its own. One that is only
  // a shelf needs the customer's words, and there aren't any.
  return data ? data.needs_item_text === true : true;
}

// The sweep runs three times a day, but a manager who has just logged "iPhone 15"
// should not wait until 12:30 to be told WSP has one. Fired without awaiting so
// the add stays instant; the pane re-fetches a few seconds later and finds it.
function kickMatchSweep(): void {
  try {
    const p = fetch(`${SB_URL}/functions/v1/callback-match?sweep=1&secret=${MATCH_SECRET}`)
      .catch(() => {});
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(p);
  } catch { /* a missed sweep is a delay, not a failure */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  if (req.method === "GET") {
    const url = new URL(req.url);

    // --- the quick-add vocabulary ------------------------------------------
    // Categories are Shopify collections (`newly-listed-devices` is excluded at
    // the table — it holds 35,049 products and gates nothing). Types are nested
    // inside their category so choosing one populates the other with no second
    // request. Sorted by how much stock the category actually holds.
    if (url.searchParams.get("vocab") === "1") {
      const [cats, types] = await Promise.all([
        supabase.from("shopify_collections")
          .select("handle, title, product_count").eq("matchable", true)
          .order("sort_order", { ascending: true }),
        supabase.from("callback_types")
          .select("id, collection_handle, name, needs_item_text").eq("active", true)
          .order("sort_order", { ascending: true }).order("name", { ascending: true }),
      ]);
      if (cats.error) return json({ error: cats.error.message }, 500);
      const byCat: Record<string, unknown[]> = {};
      for (const t of (types.data ?? [])) {
        (byCat[t.collection_handle] ||= []).push({
          id: t.id, name: t.name, needs_item_text: t.needs_item_text === true,
        });
      }
      return json({
        categories: (cats.data ?? []).map((c: any) => ({
          handle: c.handle, title: c.title, product_count: c.product_count,
          types: byCat[c.handle] ?? [],
        })),
      });
    }

    const view = url.searchParams.get("view") === "archived" ? "archived" : "active";
    const store = (url.searchParams.get("store") || "").toUpperCase();

    let q = supabase.from("customer_callbacks").select("*");
    q = view === "archived" ? q.not("archived_at", "is", null) : q.is("archived_at", null);
    if (STORES.has(store)) q = q.eq("store", store);
    const { data, error } = await q.order("date_of_call", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    const entries = data || [];

    // --- what somebody already has -----------------------------------------
    // Attached to every row for every store, deliberately: the green highlight
    // belongs to the store that HAS the item, and that store is reading the same
    // payload as the store that logged the customer.
    //
    // NEITHER `rejected` NOR `sold` SHIPS. rejected is a veto, not information.
    // sold used to, on the reasoning that a match which was there yesterday should
    // say it has gone rather than vanish — and in use that read as a third piece of
    // stock on the panel, one of which cannot be sold. A call back panel answers
    // "what can I sell this customer today", so out of stock is not an answer.
    // The state is still written by the matcher; it is just not sent to anybody.
    if (entries.length) {
      const { data: matches } = await supabase
        .from("callback_matches")
        // product_id ships so the panel can offer a Shopify ADMIN link for a
        // store's own stock. The storefront handle does not cover that case: the
        // in-stock units that were never published have no public page at all,
        // and those are exactly the ones somebody needs to go and edit.
        //
        // `condition` is the graded value the matcher copied off the shelf. It has
        // to travel with the match rather than be looked up: it is what decides
        // whether somebody rings the customer at all, and a broken unit is now
        // OFFERED rather than hidden (see fact 4 in callback-match), so the line
        // has to be able to say so.
        .select("id, callback_id, store_code, sku, title, price, product_id, product_handle, online_published, condition, score, state, found_at, match_reason, found_via, decided_by, decided_store, decided_at")
        .in("callback_id", entries.map((e: any) => e.id))
        .in("state", ["suggested", "confirmed"])
        .order("score", { ascending: false });
      const byCb: Record<string, unknown[]> = {};
      for (const m of (matches ?? [])) (byCb[m.callback_id] ||= []).push(m);
      for (const e of entries) (e as any).matches = byCb[e.id] ?? [];
    }

    return json(entries);
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { action, id } = body;
    const role = (body.role || "").toLowerCase().trim();
    const store = (body.store || "").toUpperCase();
    const multi = body.multi === true;

    // Fetch the target row once for actions that need it.
    async function getEntry() {
      if (!id) return null;
      const { data } = await supabase.from("customer_callbacks").select("*").eq("id", id).single();
      return data;
    }

    // The three matching fields, validated the same way on add and on edit.
    // A category that is not a real collection is worse than none: it would gate
    // the matcher against a handle nothing is filed under and quietly match zero.
    async function matchFields(e: any) {
      const handle = String(e.category_handle || "").trim().toLowerCase();
      // Category is the matcher's gate, so a row without one is a row that can
      // never be answered. Required rather than optional for exactly that reason.
      if (!handle) return { ok: false as const, error: "Pick a category" };
      const { data: cat } = await supabase
        .from("shopify_collections").select("handle, title").eq("handle", handle)
        .eq("matchable", true).maybeSingle();
      if (!cat) return { ok: false as const, error: "Unknown category" };
      let typeId: number | null = null;
      if (e.type_id !== null && e.type_id !== undefined && e.type_id !== "") {
        const n = Number(e.type_id);
        if (!Number.isFinite(n)) return { ok: false as const, error: "Invalid type" };
        const { data: ty } = await supabase
          .from("callback_types").select("id, collection_handle").eq("id", n).maybeSingle();
        // A type from another category would sail past the gate and then require
        // its own keywords inside a collection they never appear in.
        if (!ty || ty.collection_handle !== handle) {
          return { ok: false as const, error: "That type does not belong to that category" };
        }
        typeId = n;
      }
      return {
        ok: true as const,
        patch: {
          category_handle: handle,
          category_title: cat.title,
          type_id: typeId,
          any_model: e.any_model === true,
        },
      };
    }

    if (action === "add") {
      const e = body.entry || {};
      const targetStore = String(e.store || "").toUpperCase();
      if (!STORES.has(targetStore)) return json({ error: "Invalid store" }, 400);
      // Creation scoping: corp roles pick any store, MSM picks BAL/MPL, everyone else own store.
      const canCreate = CORP_ROLES.has(role) || store === "ALL"
        || (multi ? MSM_STORES.has(targetStore) : targetStore === store);
      if (!canCreate) return json({ error: "You can only log call backs for your own store" }, 403);

      const name = String(e.customer_name || "").trim();
      const phone = String(e.phone || "").replace(/\D/g, "");
      const item = String(e.item || "").trim();
      if (!name || !item) return json({ error: "Customer name and item are required" }, 400);
      if (phone.length !== 10) return json({ error: "Phone number must be exactly 10 digits" }, 400);

      const mf = await matchFields(e);
      if (!mf.ok) return json({ error: mf.error }, 400);

      const createdBy = String(e.created_by || body.user || "Unknown").trim();
      const note = (e.note || "").trim();
      const notes = note
        ? [{ text: note, user: createdBy, store: targetStore, at: todayCentral() }]
        : [];

      const { data, error } = await supabase
        .from("customer_callbacks")
        .insert({
          store: targetStore,
          customer_name: name,
          phone,
          item,
          created_by: createdBy,
          notes,
          ...mf.patch,
          needs_detail: await computeNeedsDetail(
            supabase, item, (mf.patch as any).type_id ?? null, e.any_model === true),
        })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      kickMatchSweep();
      return json({ success: true, entry: { ...data, matches: [] } });
    }

    if (action === "status") {
      if (!id) return json({ error: "Missing id" }, 400);
      const status = String(body.status || "").toLowerCase();
      if (!STATUSES.has(status)) return json({ error: "Invalid status" }, 400);
      const { error } = await supabase
        .from("customer_callbacks")
        .update({
          status,
          status_by: body.status_by || body.user || null,
          status_store: (body.status_store || store || null),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "note") {
      if (!id) return json({ error: "Missing id" }, 400);
      const n = body.note || {};
      const text = String(n.text || "").trim();
      if (!text) return json({ error: "Empty note" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      const notes = Array.isArray(entry.notes) ? entry.notes : [];
      notes.push({
        text,
        user: String(n.user || body.user || "Unknown"),
        store: String(n.store || store || "").toUpperCase(),
        at: n.at || todayCentral(),
      });
      const { error } = await supabase
        .from("customer_callbacks")
        .update({ notes, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "edit") {
      if (!id) return json({ error: "Missing id" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      if (!canModify(entry.store, role, store, multi)) {
        return json({ error: "You can only edit your own store's call backs" }, 403);
      }
      const f = body.fields || {};
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof f.customer_name === "string" && f.customer_name.trim()) patch.customer_name = f.customer_name.trim();
      if (typeof f.item === "string" && f.item.trim()) patch.item = f.item.trim();
      if (typeof f.phone === "string") {
        const d = f.phone.replace(/\D/g, "");
        if (d.length !== 10) return json({ error: "Phone number must be exactly 10 digits" }, 400);
        patch.phone = d;
      }
      if (typeof f.date_of_call === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.date_of_call)) patch.date_of_call = f.date_of_call;

      // The matching fields move together or not at all: a type only means
      // anything inside its category, so a half-applied patch is unmatchable.
      let reMatch = false;
      if ("category_handle" in f) {
        const mf = await matchFields(f);
        if (!mf.ok) return json({ error: mf.error }, 400);
        Object.assign(patch, mf.patch);
        reMatch = true;
      }
      if (reMatch || patch.item) {
        patch.needs_detail = await computeNeedsDetail(
          supabase,
          String(patch.item ?? entry.item),
          ("type_id" in patch ? patch.type_id : entry.type_id) as number | null,
          ("any_model" in patch ? patch.any_model : entry.any_model) === true,
        );
      }

      const { error } = await supabase.from("customer_callbacks").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 500);

      // What the row asks for has changed, so the suggestions against it are
      // answers to the old question. Confirmed and rejected rows stay: one is a
      // sale in progress, the other a veto that has to outlive an edit.
      if (reMatch || patch.item) {
        await supabase.from("callback_matches")
          .delete().eq("callback_id", id).eq("state", "suggested");
        kickMatchSweep();
      }
      return json({ success: true });
    }

    if (action === "delete") {
      if (!id) return json({ error: "Missing id" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      if (!canModify(entry.store, role, store, multi)) {
        return json({ error: "You can only delete your own store's call backs" }, 403);
      }
      // Store scope is not enough on its own here: an ASM at the right store
      // still may not destroy the row. Hiding the button is not a rule, this is.
      if (!DELETE_ROLES.has((role || "").toLowerCase().trim())) {
        return json({ error: "Ask a manager to delete this call back",
                      detail: "A manager or above deletes; anyone else can request it." }, 403);
      }
      const { error } = await supabase.from("customer_callbacks").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    // The ASM-and-below path: nothing is destroyed, a flagged note is appended.
    // Deliberately as ungated as `note` is — asking is not an action that needs
    // permission, and a request nobody may make is a rule with no way to comply.
    if (action === "delete_request") {
      if (!id) return json({ error: "Missing id" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      const n = body.note || {};
      const notes = Array.isArray(entry.notes) ? entry.notes : [];
      notes.push({
        text: String(n.text || "").trim() || "No reason given.",
        kind: "delete_request",
        user: String(n.user || body.user || "Unknown"),
        store: String(n.store || store || "").toUpperCase(),
        at: n.at || todayCentral(),
      });
      const { error } = await supabase
        .from("customer_callbacks")
        .update({ notes, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "restore") {
      if (!id) return json({ error: "Missing id" }, 400);
      const entry = await getEntry();
      if (!entry) return json({ error: "Not found" }, 404);
      if (!canModify(entry.store, role, store, multi)) {
        return json({ error: "You can only restore your own store's call backs" }, 403);
      }
      const { error } = await supabase
        .from("customer_callbacks")
        .update({
          archived_at: null,
          date_of_call: todayCentral(),  // restart the 30-day timer
          status: "open",
          status_by: null,
          status_store: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      kickMatchSweep();   // an archived row was invisible to the sweep
      return json({ success: true });
    }

    // --- answering a match --------------------------------------------------
    // 'confirmed' — that is the item; the row stays green and the match survives
    //   every later sweep (see stateByKey in callback-match).
    // 'rejected'  — permanent for this (row, item) pair, by decision. Nothing
    //   re-offers it, so a manager never dismisses the same wrong guess twice.
    //   This is what makes it safe to OFFER a broken unit rather than hide it.
    if (action === "match_confirm" || action === "match_reject") {
      const matchId = body.matchId ?? body.match_id;
      if (!matchId) return json({ error: "Missing matchId" }, 400);
      const { data: m } = await supabase
        .from("callback_matches").select("id, store_code, state, callback_id").eq("id", matchId).maybeSingle();
      if (!m) return json({ error: "Not found" }, 404);
      // ⚠️ EITHER STORE'S MANAGEMENT. This was the HOLDING store only, which is
      // right for a question about the stock — but the question "Not This" usually
      // answers is about the CUSTOMER ("they would not want a broken one"), and
      // that is known by the store that took the call. Under the old rule an OVL
      // manager could not dismiss MPL's broken PS5 from their own customer's row.
      // Mirrors cbCanDecide in speeks.js; see [[kpi-role-gate]] for the cost of
      // those two drifting.
      const { data: owner } = m.callback_id
        ? await supabase.from("customer_callbacks").select("store").eq("id", m.callback_id).maybeSingle()
        : { data: null };
      const loggedBy = owner?.store ?? null;
      const allowed = canDecideMatch(m.store_code, role, store, multi)
        || (!!loggedBy && canDecideMatch(loggedBy, role, store, multi));
      if (!allowed) {
        return json({ error: loggedBy && loggedBy !== m.store_code
          ? `Only ${m.store_code}'s or ${loggedBy}'s managers can answer this match`
          : `Only ${m.store_code}'s managers can answer this match` }, 403);
      }
      const state = action === "match_confirm" ? "confirmed" : "rejected";
      if (!MATCH_STATES.has(state)) return json({ error: "Invalid state" }, 400);
      const { error } = await supabase.from("callback_matches").update({
        state,
        decided_by: body.user || null,
        decided_store: store || null,
        decided_at: new Date().toISOString(),
      }).eq("id", matchId);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, state });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
