import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// B2B deal tracker — 6-stage pipeline.
// Stages: Location Pending → Pricing → Quote → Awaiting Client → Listing → Completed
// Authorization is enforced client-side (PIN trust model, matching the app); this
// function enforces legal STATE TRANSITIONS so the pipeline can't be corrupted.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---------------- GET ----------------
  if (req.method === "GET") {
    const url = new URL(req.url);
    const dealId = url.searchParams.get("deal_id");

    // client directory (CRM)
    if (url.searchParams.get("clients")) {
      const { data, error } = await supabase
        .from("b2b_clients")
        .select("id, company, contact, contact_email, contact_phone, notes, created_at, updated_at")
        .order("company", { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json(data || []);
    }

    // detail: items for one deal
    if (dealId) {
      const { data, error } = await supabase
        .from("b2b_deal_items")
        .select("id, deal_id, make, model, condition, staff_notes, client_notes, quantity, value, offer, recycle, listed, created_at")
        .eq("deal_id", dealId)
        .order("created_at", { ascending: true });
      if (error) return json({ error: error.message }, 500);
      const items = (data || []).map((it: any) => ({
        ...it,
        qty_offer_total: Number(it.quantity) * Number(it.offer),
        qty_value_total: Number(it.quantity) * Number(it.value),
      }));
      return json(items);
    }

    // list: deals (optionally store-filtered) + rolled-up totals + listing progress
    const store = (url.searchParams.get("store") || "").toUpperCase();
    let q = supabase
      .from("b2b_deals")
      .select("id, company, contact, client_id, pickup_date, status, assigned_store, created_by, priced_by, client_payout, quoted, quote_emailed, client_confirmed, quote_no, delivered_by, received_by, created_at, updated_at, stage_changed_at")
      .order("created_at", { ascending: false });
    if (store && store !== "ALL" && store !== "CORP") q = q.eq("assigned_store", store);
    const { data: deals, error } = await q;
    if (error) return json({ error: error.message }, 500);

    const ids = (deals || []).map((d: any) => d.id);
    const totals: Record<string, any> = {};
    if (ids.length) {
      const { data: items, error: iErr } = await supabase
        .from("b2b_deal_items")
        .select("deal_id, quantity, value, offer, recycle, listed")
        .in("deal_id", ids);
      if (iErr) return json({ error: iErr.message }, 500);
      for (const it of items || []) {
        const t = (totals[it.deal_id] ||= {
          total_offer: 0, total_value: 0, total_qty: 0, line_count: 0,
          listed_done: 0, listed_total: 0, unlisted_value: 0, unlisted_offer: 0,
        });
        const qty = Number(it.quantity);
        // recycle-only items carry no offer/price, so they don't add to the money totals
        if (!it.recycle) {
          t.total_offer += qty * Number(it.offer);
          t.total_value += qty * Number(it.value);
        }
        t.total_qty += qty;
        t.line_count += 1;
        t.listed_total += 1;
        if (it.listed) {
          t.listed_done += 1;
        } else if (!it.recycle) {
          t.unlisted_value += qty * Number(it.value);
          t.unlisted_offer += qty * Number(it.offer);
        }
      }
    }

    const result = (deals || []).map((d: any) => ({
      ...d,
      total_offer: totals[d.id]?.total_offer ?? 0,
      total_value: totals[d.id]?.total_value ?? 0,
      total_qty: totals[d.id]?.total_qty ?? 0,
      line_count: totals[d.id]?.line_count ?? 0,
      listed_done: totals[d.id]?.listed_done ?? 0,
      listed_total: totals[d.id]?.listed_total ?? 0,
      unlisted_value: totals[d.id]?.unlisted_value ?? 0,
      unlisted_offer: totals[d.id]?.unlisted_offer ?? 0,
    }));
    return json(result);
  }

  // ---------------- POST ----------------
  if (req.method === "POST") {
    let body: any = {};
    try { body = JSON.parse(await req.text()); } catch (_) {}
    const action = body.action;
    const now = new Date().toISOString();

    const getDeal = async (id: string) => {
      const { data, error } = await supabase.from("b2b_deals").select("*").eq("id", id).single();
      return { deal: data, error };
    };
    const itemParentStatus = async (itemId: string) => {
      const { data, error } = await supabase.from("b2b_deal_items").select("deal_id").eq("id", itemId).single();
      if (error || !data) return { status: null, dealId: null, error };
      const { deal } = await getDeal(data.deal_id);
      return { status: deal?.status ?? null, dealId: data.deal_id, error: null };
    };
    const touch = (id: string, patch: any = {}) =>
      supabase.from("b2b_deals").update({ ...patch, updated_at: now }).eq("id", id);
    // use for stage transitions so the "time in stage" clock only moves on real moves
    const touchStage = (id: string, patch: any = {}) =>
      supabase.from("b2b_deals").update({ ...patch, updated_at: now, stage_changed_at: now }).eq("id", id);

    // ----- create -----
    if (action === "create") {
      const company = (body.company || "").trim();
      const pickup_date = (body.pickup_date || "").trim();
      if (!company || !pickup_date) return json({ error: "Missing company or pickup_date" }, 400);
      const { data, error } = await supabase.from("b2b_deals").insert({
        company,
        contact: (body.contact || "").trim() || null,
        client_id: body.client_id || null,
        pickup_date,
        created_by: body.created_by || "Unknown",
        status: "Location Pending",
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ success: true, id: data.id });
    }

    // ----- client CRM (DM/CEO; gated client-side) -----
    if (action === "create_client" || action === "update_client") {
      const company = (body.company || "").trim();
      if (!company) return json({ error: "Company name is required" }, 400);
      const fields = {
        company,
        contact: (body.contact || "").trim() || null,
        contact_email: (body.contact_email || "").trim() || null,
        contact_phone: (body.contact_phone || "").trim() || null,
        notes: (body.notes || "").trim() || null,
      };
      if (action === "create_client") {
        const { data, error } = await supabase.from("b2b_clients").insert(fields).select("id").single();
        if (error) {
          if (String(error.message).toLowerCase().includes("duplicate")) return json({ error: "A client with that company name already exists." }, 409);
          return json({ error: error.message }, 500);
        }
        return json({ success: true, id: data.id });
      }
      if (!body.id) return json({ error: "Missing client id" }, 400);
      const { error } = await supabase.from("b2b_clients").update({ ...fields, updated_at: now }).eq("id", body.id);
      if (error) {
        if (String(error.message).toLowerCase().includes("duplicate")) return json({ error: "A client with that company name already exists." }, 409);
        return json({ error: error.message }, 500);
      }
      return json({ success: true });
    }
    if (action === "delete_client") {
      if (!body.id) return json({ error: "Missing client id" }, 400);
      const { error } = await supabase.from("b2b_clients").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    // ----- assign store: Location Pending -> Pricing -----
    if (action === "assign_advance") {
      const { id } = body;
      const assigned_store = (body.assigned_store || "").toUpperCase();
      if (!id || !assigned_store) return json({ error: "Missing id or assigned_store" }, 400);
      const { deal, error } = await getDeal(id);
      if (error) return json({ error: error.message }, 500);
      if (deal.status !== "Location Pending") return json({ error: `Cannot assign from '${deal.status}'` }, 409);
      const { error: uErr } = await touchStage(id, {
        assigned_store, status: "Pricing",
        delivered_by: (body.delivered_by || "").trim() || null,
        received_by:  (body.received_by  || "").trim() || null,
      });
      if (uErr) return json({ error: uErr.message }, 500);
      return json({ success: true });
    }

    // ----- item CRUD (only while parent is Pricing) -----
    if (action === "add_item" || action === "update_item" || action === "delete_item") {
      if (action === "add_item") {
        const dealId = body.deal_id;
        if (!dealId) return json({ error: "Missing deal_id" }, 400);
        const { deal } = await getDeal(dealId);
        if (deal?.status !== "Pricing") return json({ error: "Items editable only while Pricing" }, 409);
        const recycle = !!body.recycle;
        const { error } = await supabase.from("b2b_deal_items").insert({
          deal_id: dealId,
          make: body.make || null,
          model: body.model || null,
          condition: body.condition || null,
          staff_notes: body.staff_notes || null,
          client_notes: body.client_notes || null,
          quantity: Number(body.quantity) || 1,
          value: recycle ? 0 : (Number(body.value) || 0),
          offer: recycle ? 0 : (Number(body.offer) || 0),
          recycle,
        });
        if (error) return json({ error: error.message }, 500);
        await touch(dealId);
        return json({ success: true });
      }
      const { status, dealId, error } = await itemParentStatus(body.id);
      if (error) return json({ error: error.message }, 500);
      if (!dealId) return json({ error: "Item not found" }, 404);
      if (status !== "Pricing") return json({ error: "Items editable only while Pricing" }, 409);
      if (action === "update_item") {
        const patch: any = {};
        for (const k of ["make", "model", "condition", "staff_notes", "client_notes"]) if (k in body) patch[k] = body[k] || null;
        for (const k of ["quantity", "value", "offer"]) if (k in body) patch[k] = Number(body[k]) || 0;
        if ("recycle" in body) patch.recycle = !!body.recycle;
        // recycle-only items never carry an offer/price
        if (patch.recycle === true) { patch.value = 0; patch.offer = 0; }
        const { error: uErr } = await supabase.from("b2b_deal_items").update(patch).eq("id", body.id);
        if (uErr) return json({ error: uErr.message }, 500);
      } else {
        const { error: dErr } = await supabase.from("b2b_deal_items").delete().eq("id", body.id);
        if (dErr) return json({ error: dErr.message }, 500);
      }
      await touch(dealId);
      return json({ success: true });
    }

    // ----- per-item offer edit during Quote -----
    if (action === "update_quote_item") {
      const { status, dealId, error } = await itemParentStatus(body.id);
      if (error) return json({ error: error.message }, 500);
      if (!dealId) return json({ error: "Item not found" }, 404);
      const patch: any = {};
      // offers only change while quoting; client notes can also be edited while awaiting the client
      if ("offer" in body) {
        if (status !== "Quote") return json({ error: "Offers are editable only during Quote" }, 409);
        patch.offer = Number(body.offer) || 0;
      }
      if ("client_notes" in body) {
        if (status !== "Quote" && status !== "Awaiting Client") return json({ error: "Notes are editable only during Quote / Awaiting Client" }, 409);
        patch.client_notes = body.client_notes || null;
      }
      if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
      const { error: uErr } = await supabase.from("b2b_deal_items").update(patch).eq("id", body.id);
      if (uErr) return json({ error: uErr.message }, 500);
      await touch(dealId);
      return json({ success: true });
    }

    // ----- submit pricing: Pricing -> Quote -----
    if (action === "submit_pricing") {
      const { id } = body;
      const { deal, error } = await getDeal(id);
      if (error) return json({ error: error.message }, 500);
      if (deal.status !== "Pricing") return json({ error: `Cannot submit from '${deal.status}'` }, 409);
      const { count } = await supabase.from("b2b_deal_items").select("id", { count: "exact", head: true }).eq("deal_id", id);
      if (!count) return json({ error: "Add at least one item before submitting" }, 400);
      const { error: uErr } = await touchStage(id, { status: "Quote", priced_by: body.priced_by || deal.priced_by || null });
      if (uErr) return json({ error: uErr.message }, 500);
      return json({ success: true });
    }

    // ----- generate quote (stays in Quote; payout derived from per-item offers) -----
    if (action === "generate_quote") {
      const { id } = body;
      const { deal, error } = await getDeal(id);
      if (error) return json({ error: error.message }, 500);
      if (deal.status !== "Quote") return json({ error: `Cannot quote from '${deal.status}'` }, 409);
      const { error: uErr } = await touch(id, { quoted: true });
      if (uErr) return json({ error: uErr.message }, 500);
      return json({ success: true });
    }

    // ----- email quote: Quote -> Awaiting Client -----
    if (action === "email_quote") {
      const { id } = body;
      const { deal, error } = await getDeal(id);
      if (error) return json({ error: error.message }, 500);
      if (deal.status !== "Quote") return json({ error: `Cannot email from '${deal.status}'` }, 409);
      const { error: uErr } = await touchStage(id, { status: "Awaiting Client", quoted: true, quote_emailed: true });
      if (uErr) return json({ error: uErr.message }, 500);
      return json({ success: true });
    }

    // ----- client response: Awaiting Client -> Listing (confirm) | Pricing (decline) -----
    if (action === "client_response") {
      const { id } = body;
      const { deal, error } = await getDeal(id);
      if (error) return json({ error: error.message }, 500);
      if (deal.status !== "Awaiting Client") return json({ error: `Cannot respond from '${deal.status}'` }, 409);
      const patch = body.confirmed
        ? { status: "Listing", client_confirmed: true }
        : { status: "Pricing", quoted: false, quote_emailed: false, client_payout: null };
      const { error: uErr } = await touchStage(id, patch);
      if (uErr) return json({ error: uErr.message }, 500);
      return json({ success: true });
    }

    // ----- toggle listed flag (only while Listing) -----
    if (action === "toggle_listed") {
      const { status, dealId, error } = await itemParentStatus(body.id);
      if (error) return json({ error: error.message }, 500);
      if (!dealId) return json({ error: "Item not found" }, 404);
      if (status !== "Listing") return json({ error: "Listing edits only while Listing" }, 409);
      const { data: it } = await supabase.from("b2b_deal_items").select("listed").eq("id", body.id).single();
      const { error: uErr } = await supabase.from("b2b_deal_items").update({ listed: !it?.listed }).eq("id", body.id);
      if (uErr) return json({ error: uErr.message }, 500);
      await touch(dealId);
      return json({ success: true });
    }

    // ----- complete: Listing -> Completed -----
    if (action === "complete") {
      const { id } = body;
      const { deal, error } = await getDeal(id);
      if (error) return json({ error: error.message }, 500);
      if (deal.status !== "Listing") return json({ error: `Cannot complete from '${deal.status}'` }, 409);
      const { error: uErr } = await touchStage(id, { status: "Completed" });
      if (uErr) return json({ error: uErr.message }, 500);
      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
