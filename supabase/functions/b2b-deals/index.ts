import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// B2B deal tracker. A business sells us bulk electronics; we collect them,
// itemize and price them, quote the client, and once they accept, the goods
// become our inventory and get listed for resale.
//
// Pipeline (each stage has exactly one owner, so "needs you" is derivable from
// the stage alone):
//   pickup            corp    typed-name sign-off + pickup date
//   pricing_location  corp    route to OVL/LEE/WSP/MPL/BAL/CORP
//   pricing           store   itemize and price
//   quote             corp    quote goes out from the quoter's own mailbox as
//                             a mailto draft, so replies reach them; stays
//                             editable while the client negotiates, and only
//                             a CEO/TOM/DM may accept it
//   listing_location  corp    ONLY when pricing happened at CORP
//   listing           store   check off / scan each unit; recycle bad ones
//   completed         —       terminal
//   cancelled         —       terminal, from any pre-listing stage
//
// Accepting a quote is the hinge: offers freeze into `cost`, SKUs freeze, and
// the deal routes onward. Everything downstream treats the items as inventory.
//
// Authorization is client-side (PIN trust model, matching the rest of the app);
// what THIS function enforces is legal state transitions, so a stale tab or a
// hand-rolled request can't corrupt a pipeline. Tables: b2b_clients +
// b2b_deals + b2b_deal_items.

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const PRICING_LOCATIONS = [...STORES, "CORP"];
const ACCEPT_ROLES = ["ceo", "tom", "district manager"];
// Conditions that oblige the pricer to explain themselves on the quote.
const REASON_CONDITIONS = ["Fair", "For Parts"];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseInt0(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function txt(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const dealRef = (acronym: string, dealNo: number) => `${acronym}-${pad(dealNo, 3)}`;
const skuFor = (acronym: string, dealNo: number, lineNo: number) =>
  `${dealRef(acronym, dealNo)}-${pad(lineNo, 4)}`;

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

// A real stage move stamps stage_changed_at (drives the "days in stage" clock);
// an in-stage edit only touches updated_at.
const touch      = () => ({ updated_at: new Date().toISOString() });
const touchStage = () => ({ updated_at: new Date().toISOString(), stage_changed_at: new Date().toISOString() });

async function getDeal(sb: any, id: string) {
  const { data, error } = await sb
    .from("b2b_deals")
    .select("*, client:b2b_clients(id, company, acronym, contact, contact_email, contact_phone)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// The store a change should ping. Listing store once it exists, else pricing.
const dealStore = (d: any) => d?.listing_store || d?.pricing_store || null;

// ---------------------------------------------------------------------------

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

      // ===================================================== client directory

      if (action === "create_client" || action === "update_client") {
        const company = txt(body.company);
        const acronym = String(body.acronym || "").trim().toUpperCase();
        if (!company) return jsonResponse({ success: false, error: "Company name is required." }, 400);
        if (!/^[A-Z0-9]{2,6}$/.test(acronym)) {
          return jsonResponse({ success: false, error: "Acronym must be 2-6 letters or digits (it leads every SKU)." }, 400);
        }
        const row: Record<string, unknown> = {
          company, acronym,
          contact: txt(body.contact),
          contact_email: txt(body.contact_email),
          contact_phone: txt(body.contact_phone),
          notes: txt(body.notes),
        };

        if (action === "create_client") {
          const { data, error } = await supabase.from("b2b_clients").insert(row).select("id").single();
          if (error) {
            const dupe = String(error.message).toLowerCase().includes("duplicate");
            return jsonResponse({ success: false, error: dupe ? "That company name or acronym is already taken." : error.message }, dupe ? 409 : 500);
          }
          await broadcastChange("b2b", null);
          return jsonResponse({ success: true, id: data.id });
        }

        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "id is required" }, 400);
        // The acronym is baked into every SKU already printed on a label, so it
        // can only change while the client has no deal past pricing.
        const { data: locked } = await supabase.from("b2b_deals")
          .select("id, stage").eq("client_id", id)
          .not("stage", "in", '("pickup","pricing_location","pricing","cancelled")').limit(1);
        const { data: current } = await supabase.from("b2b_clients").select("acronym").eq("id", id).maybeSingle();
        if (locked?.length && current && current.acronym !== acronym) {
          return jsonResponse({ success: false, error: "This client already has quoted deals — the acronym is locked into their SKUs." }, 409);
        }
        const { error } = await supabase.from("b2b_clients").update({ ...row, ...touch() }).eq("id", id);
        if (error) {
          const dupe = String(error.message).toLowerCase().includes("duplicate");
          return jsonResponse({ success: false, error: dupe ? "That company name or acronym is already taken." : error.message }, dupe ? 409 : 500);
        }
        await broadcastChange("b2b", null);
        return jsonResponse({ success: true });
      }

      if (action === "delete_client") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "id is required" }, 400);
        const { data: deals } = await supabase.from("b2b_deals").select("id").eq("client_id", id).limit(1);
        if (deals?.length) {
          return jsonResponse({ success: false, error: "This client has deals on record — they can't be deleted." }, 409);
        }
        const { error } = await supabase.from("b2b_clients").delete().eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", null);
        return jsonResponse({ success: true });
      }

      // ============================================================ new deal

      if (action === "create") {
        const clientId = String(body.client_id || "");
        if (!clientId) return jsonResponse({ success: false, error: "Pick a client for this deal." }, 400);
        const { data: client, error: cErr } = await supabase.from("b2b_clients")
          .select("id, acronym").eq("id", clientId).maybeSingle();
        if (cErr) return jsonResponse({ success: false, error: cErr.message }, 500);
        if (!client) return jsonResponse({ success: false, error: "That client no longer exists." }, 404);

        // Per-client counter. The unique index is the real guard; on a race we
        // recompute once and retry, which is plenty for this volume.
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data: last } = await supabase.from("b2b_deals")
            .select("deal_no").eq("client_id", clientId)
            .order("deal_no", { ascending: false }).limit(1).maybeSingle();
          const dealNo = (last?.deal_no || 0) + 1;
          const { data, error } = await supabase.from("b2b_deals").insert({
            client_id: clientId,
            deal_no: dealNo,
            stage: "pickup",
            pickup_desc: txt(body.pickup_desc),
            created_by: txt(body.created_by) || "Unknown",
          }).select("id").single();
          if (!error) {
            await broadcastChange("b2b", null);
            return jsonResponse({ success: true, id: data.id, deal_no: dealNo, ref: dealRef(client.acronym, dealNo) });
          }
          if (!String(error.message).toLowerCase().includes("duplicate")) {
            return jsonResponse({ success: false, error: error.message }, 500);
          }
        }
        return jsonResponse({ success: false, error: "Couldn't assign a deal number — try again." }, 409);
      }

      // ==================================================== stage transitions

      if (action === "sign_pickup") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pickup") return jsonResponse({ success: false, error: "This pickup has already been signed off." }, 409);
        const signedBy = txt(body.signed_by);
        const pickupDate = txt(body.pickup_date);
        if (!signedBy) return jsonResponse({ success: false, error: "The client's name is required to sign off the pickup." }, 400);
        if (!pickupDate) return jsonResponse({ success: false, error: "A pickup date is required." }, 400);
        const { error } = await supabase.from("b2b_deals").update({
          stage: "pricing_location",
          pickup_desc: txt(body.pickup_desc),
          signed_by: signedBy,
          signed_at: new Date().toISOString(),
          pickup_date: pickupDate,
          ...touchStage(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", null);
        return jsonResponse({ success: true });
      }

      if (action === "assign_pricing") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pricing_location") return jsonResponse({ success: false, error: "This deal isn't waiting for a pricing location." }, 409);
        const store = String(body.pricing_store || "").toUpperCase();
        if (!PRICING_LOCATIONS.includes(store)) return jsonResponse({ success: false, error: "Pick a valid pricing location." }, 400);
        const { error } = await supabase.from("b2b_deals").update({
          stage: "pricing",
          pricing_store: store,
          delivered_by: txt(body.delivered_by),
          received_by: txt(body.received_by),
          ...touchStage(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", store);
        return jsonResponse({ success: true });
      }

      // ============================================================== items
      // Editable through `pricing` AND `quote` — the quote stays open while the
      // client negotiates, right up until someone accepts it.

      if (action === "add_item" || action === "update_item" || action === "delete_item") {
        const dealId = String(body.deal_id || "");
        const itemId = String(body.id || "");

        let deal: any;
        if (action === "add_item") {
          deal = await getDeal(supabase, dealId);
        } else {
          const { data: it } = await supabase.from("b2b_deal_items").select("deal_id").eq("id", itemId).maybeSingle();
          if (!it) return jsonResponse({ success: false, error: "Line item not found." }, 404);
          deal = await getDeal(supabase, it.deal_id);
        }
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pricing" && deal.stage !== "quote") {
          return jsonResponse({ success: false, error: "Line items can only be changed while pricing or quoting." }, 409);
        }

        if (action === "delete_item") {
          const { error } = await supabase.from("b2b_deal_items").delete().eq("id", itemId);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
          await supabase.from("b2b_deals").update(touch()).eq("id", deal.id);
          await broadcastChange("b2b", dealStore(deal));
          return jsonResponse({ success: true });
        }

        const recycleOnly = body.recycle_only === true;
        const fields: Record<string, unknown> = {
          make: txt(body.make),
          model: txt(body.model),
          condition: txt(body.condition),
          staff_notes: txt(body.staff_notes),
          client_notes: txt(body.client_notes),
          quantity: Math.max(1, parseInt0(body.quantity) || 1),
          recycle_only: recycleOnly,
          // A recycle-only line is scrap: it carries no resale value and no offer.
          value: recycleOnly ? 0 : parseNum(body.value),
          offer: recycleOnly ? 0 : parseNum(body.offer),
        };

        if (action === "update_item") {
          const { error } = await supabase.from("b2b_deal_items").update(fields).eq("id", itemId);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
          await supabase.from("b2b_deals").update(touch()).eq("id", deal.id);
          await broadcastChange("b2b", dealStore(deal));
          return jsonResponse({ success: true });
        }

        // add_item — next line number for this deal. The SKU is assigned right
        // here so a label can be printed the moment the line exists. Line
        // numbers are never reused, so deleting and re-adding leaves a gap and
        // mints a fresh SKU; nothing is frozen until the quote is accepted.
        const { data: last } = await supabase.from("b2b_deal_items")
          .select("line_no").eq("deal_id", deal.id)
          .order("line_no", { ascending: false }).limit(1).maybeSingle();
        const lineNo = (last?.line_no || 0) + 1;
        const acronym = deal.client?.acronym || "B2B";
        const { data, error } = await supabase.from("b2b_deal_items").insert({
          ...fields,
          deal_id: deal.id,
          line_no: lineNo,
          sku: skuFor(acronym, deal.deal_no, lineNo),
        }).select("id, line_no, sku").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await supabase.from("b2b_deals").update(touch()).eq("id", deal.id);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true, id: data.id, line_no: data.line_no, sku: data.sku });
      }

      // ============================================================== quoting

      if (action === "submit_pricing") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pricing") return jsonResponse({ success: false, error: "This deal isn't in pricing." }, 409);
        const { data: items } = await supabase.from("b2b_deal_items")
          .select("id, line_no, sku, make, model, condition, client_notes").eq("deal_id", deal.id).order("line_no", { ascending: true });
        if (!items?.length) return jsonResponse({ success: false, error: "Add at least one line item before submitting." }, 400);

        // A line downgraded to Fair or For Parts has to carry a client-facing
        // reason -- it prints on the quote and is what justifies the low offer.
        const unreasoned = items.filter((it: any) =>
          REASON_CONDITIONS.includes(String(it.condition || "")) && !String(it.client_notes || "").trim());
        if (unreasoned.length) {
          const names = unreasoned.map((it: any) =>
            [it.make, it.model].filter(Boolean).join(" ") || `Line ${it.line_no}`).join(", ");
          return jsonResponse({ success: false, error: `These lines are marked Fair or For Parts and need a reason: ${names}` }, 400);
        }

        // Backfill for any line created before SKUs were assigned on insert.
        const acronym = deal.client?.acronym || "B2B";
        for (const it of items) {
          if (it.sku) continue;
          const { error } = await supabase.from("b2b_deal_items")
            .update({ sku: skuFor(acronym, deal.deal_no, it.line_no) }).eq("id", it.id);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
        }

        const { error } = await supabase.from("b2b_deals").update({
          stage: "quote",
          priced_by: txt(body.priced_by),
          ...touchStage(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true });
      }

      // The quote goes out from the quoter's own mailbox via a mailto draft, so
      // the client's reply reaches the person who priced it. This just records
      // that it went out, for the stage clock and the Overview.
      if (action === "send_quote") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "quote") return jsonResponse({ success: false, error: "Only a deal in the quote stage can be sent." }, 409);
        const { error } = await supabase.from("b2b_deals").update({
          quote_sent_at: new Date().toISOString(),
          quote_send_count: (deal.quote_send_count || 0) + 1,
          ...touch(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true, to: txt(body.to) });
      }

      // The hinge: offers freeze into cost, SKUs freeze, and the deal routes on.
      if (action === "accept_quote") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "quote") return jsonResponse({ success: false, error: "Only a deal in the quote stage can be accepted." }, 409);
        const role = String(body.role || "").toLowerCase().trim();
        if (!ACCEPT_ROLES.includes(role)) {
          return jsonResponse({ success: false, error: "Only a CEO, TOM or District Manager can accept a quote." }, 403);
        }

        const { data: items } = await supabase.from("b2b_deal_items")
          .select("id, line_no, sku, offer, make, model, condition, client_notes")
          .eq("deal_id", deal.id).order("line_no", { ascending: true });
        if (!items?.length) return jsonResponse({ success: false, error: "This quote has no line items." }, 400);

        // Same gate as submit_pricing: the quote stays editable right up to
        // here, so a reason could have been cleared after it was first checked.
        const unreasoned = items.filter((it: any) =>
          REASON_CONDITIONS.includes(String(it.condition || "")) && !String(it.client_notes || "").trim());
        if (unreasoned.length) {
          const names = unreasoned.map((it: any) =>
            [it.make, it.model].filter(Boolean).join(" ") || `Line ${it.line_no}`).join(", ");
          return jsonResponse({ success: false, error: `These lines are marked Fair or For Parts and need a reason: ${names}` }, 400);
        }

        const acronym = deal.client?.acronym || "B2B";
        for (const it of items) {
          const patch: Record<string, unknown> = { cost: parseNum(it.offer) };
          if (!it.sku) patch.sku = skuFor(acronym, deal.deal_no, it.line_no);
          const { error } = await supabase.from("b2b_deal_items").update(patch).eq("id", it.id);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
        }

        // CORP priced it, so someone still has to say which store lists it.
        const toCorp = deal.pricing_store === "CORP";
        const { error } = await supabase.from("b2b_deals").update({
          stage: toCorp ? "listing_location" : "listing",
          listing_store: toCorp ? null : deal.pricing_store,
          accepted_at: new Date().toISOString(),
          accepted_by: txt(body.accepted_by),
          ...touchStage(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", toCorp ? null : deal.pricing_store);
        return jsonResponse({ success: true, next_stage: toCorp ? "listing_location" : "listing" });
      }

      if (action === "assign_listing") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "listing_location") return jsonResponse({ success: false, error: "This deal isn't waiting for a listing location." }, 409);
        const store = String(body.listing_store || "").toUpperCase();
        if (!STORES.includes(store)) return jsonResponse({ success: false, error: "Pick a valid store to list at." }, 400);
        const { error } = await supabase.from("b2b_deals").update({
          stage: "listing", listing_store: store, ...touchStage(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", store);
        return jsonResponse({ success: true });
      }

      // ============================================================== listing

      // mark_listed  { id, delta }        tick a unit up or down
      // scan_sku     { deal_id, sku }     barcode scan → +1 on the matching line
      // recycle_units{ id, units }        pull bad units out of the line
      if (action === "mark_listed" || action === "recycle_units" || action === "scan_sku") {
        let item: any;
        if (action === "scan_sku") {
          const dealId = String(body.deal_id || "");
          const sku = String(body.sku || "").trim().toUpperCase();
          if (!sku) return jsonResponse({ success: false, error: "No SKU scanned." }, 400);
          const { data } = await supabase.from("b2b_deal_items")
            .select("*").eq("deal_id", dealId).eq("sku", sku).maybeSingle();
          if (!data) return jsonResponse({ success: false, error: `${sku} isn't a line on this deal.` }, 404);
          item = data;
        } else {
          const { data } = await supabase.from("b2b_deal_items").select("*").eq("id", String(body.id || "")).maybeSingle();
          if (!data) return jsonResponse({ success: false, error: "Line item not found." }, 404);
          item = data;
        }

        const deal = await getDeal(supabase, item.deal_id);
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "listing") return jsonResponse({ success: false, error: "Listing progress can only change while the deal is in listing." }, 409);

        const qty = parseInt0(item.quantity) || 1;
        let listed = parseInt0(item.listed_qty);
        let recycled = parseInt0(item.recycled_qty);

        if (action === "recycle_units") {
          const units = Math.max(1, parseInt0(body.units) || 1);
          const room = qty - listed - recycled;
          if (room <= 0) return jsonResponse({ success: false, error: "Every unit on this line is already accounted for." }, 409);
          recycled += Math.min(units, room);
        } else {
          const delta = action === "scan_sku" ? 1 : (parseInt0(body.delta) || 1);
          const next = listed + delta;
          if (next < 0) return jsonResponse({ success: false, error: "That line is already at zero." }, 409);
          if (next + recycled > qty) {
            return jsonResponse({ success: false, error: `${item.sku || "This line"} is already fully listed (${listed}/${qty}).` }, 409);
          }
          listed = next;
        }

        const { error } = await supabase.from("b2b_deal_items")
          .update({ listed_qty: listed, recycled_qty: recycled }).eq("id", item.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await supabase.from("b2b_deals").update(touch()).eq("id", deal.id);

        // Tell the client whether that was the last outstanding unit, so it can
        // fire the celebration without a second round-trip.
        const { data: all } = await supabase.from("b2b_deal_items")
          .select("quantity, listed_qty, recycled_qty").eq("deal_id", deal.id);
        const allDone = (all || []).every((r: any) =>
          parseInt0(r.listed_qty) + parseInt0(r.recycled_qty) >= (parseInt0(r.quantity) || 1));

        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({
          success: true,
          item_id: item.id, sku: item.sku,
          listed_qty: listed, recycled_qty: recycled, quantity: qty,
          all_done: allDone,
        });
      }

      if (action === "complete") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "listing") return jsonResponse({ success: false, error: "Only a deal in listing can be completed." }, 409);
        const { data: items } = await supabase.from("b2b_deal_items")
          .select("quantity, listed_qty, recycled_qty").eq("deal_id", deal.id);
        const outstanding = (items || []).reduce((n: number, r: any) =>
          n + Math.max(0, (parseInt0(r.quantity) || 1) - parseInt0(r.listed_qty) - parseInt0(r.recycled_qty)), 0);
        if (outstanding > 0) {
          return jsonResponse({ success: false, error: `${outstanding} unit${outstanding === 1 ? "" : "s"} still need listing or recycling.` }, 409);
        }
        const { error } = await supabase.from("b2b_deals").update({ stage: "completed", ...touchStage() }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true });
      }

      if (action === "cancel") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (["listing", "completed", "cancelled"].includes(deal.stage)) {
          return jsonResponse({ success: false, error: "A deal this far along can't be cancelled." }, 409);
        }
        const { error } = await supabase.from("b2b_deals").update({
          stage: "cancelled", cancelled_reason: txt(body.reason), ...touchStage(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---------------------------------------------------------------- GET reads

  try {
    const url = new URL(req.url);

    // ?clients=1 → the directory, with each client's deal count
    if (url.searchParams.get("clients")) {
      const { data, error } = await supabase.from("b2b_clients")
        .select("*").order("company", { ascending: true });
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      const { data: deals } = await supabase.from("b2b_deals").select("client_id, stage");
      const counts: Record<string, { total: number; open: number }> = {};
      (deals || []).forEach((d: any) => {
        const c = counts[d.client_id] || (counts[d.client_id] = { total: 0, open: 0 });
        c.total++;
        if (d.stage !== "completed" && d.stage !== "cancelled") c.open++;
      });
      return jsonResponse({
        success: true,
        data: (data || []).map((c: any) => ({ ...c, deal_count: counts[c.id]?.total || 0, open_count: counts[c.id]?.open || 0 })),
      });
    }

    // ?deal_id=<uuid> → that deal's line items
    const dealId = url.searchParams.get("deal_id");
    if (dealId) {
      const { data, error } = await supabase.from("b2b_deal_items")
        .select("*").eq("deal_id", dealId).order("line_no", { ascending: true });
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      return jsonResponse({
        success: true,
        data: (data || []).map((it: any) => {
          const qty = parseInt0(it.quantity) || 1;
          const done = parseInt0(it.listed_qty) + parseInt0(it.recycled_qty);
          return {
            ...it,
            qty_value_total: it.recycle_only ? 0 : parseNum(it.value) * qty,
            qty_offer_total: it.recycle_only ? 0 : parseNum(it.offer) * qty,
            outstanding: Math.max(0, qty - done),
            satisfied: done >= qty,
          };
        }),
      });
    }

    // ?store=ALL|<CODE> → the deal list with per-deal rollups.
    // A store sees anything it prices or lists; corp roles pass ALL.
    const store = String(url.searchParams.get("store") || "ALL").toUpperCase();
    let q = supabase.from("b2b_deals")
      .select("*, client:b2b_clients(id, company, acronym, contact, contact_email, contact_phone)")
      .order("created_at", { ascending: false });
    if (store && store !== "ALL") {
      q = q.or(`pricing_store.eq.${store},listing_store.eq.${store}`);
    }
    const { data: deals, error } = await q;
    if (error) return jsonResponse({ success: false, error: error.message }, 500);

    const ids = (deals || []).map((d: any) => d.id);
    const roll: Record<string, any> = {};
    if (ids.length) {
      const { data: items } = await supabase.from("b2b_deal_items")
        .select("deal_id, quantity, value, offer, cost, recycle_only, listed_qty, recycled_qty")
        .in("deal_id", ids);
      (items || []).forEach((it: any) => {
        const r = roll[it.deal_id] || (roll[it.deal_id] = {
          total_value: 0, total_offer: 0, total_cost: 0, total_units: 0,
          line_count: 0, listed_units: 0, recycled_units: 0, outstanding_units: 0,
        });
        const qty = parseInt0(it.quantity) || 1;
        const listed = parseInt0(it.listed_qty);
        const recycled = parseInt0(it.recycled_qty);
        r.line_count++;
        r.total_units += qty;
        r.listed_units += listed;
        r.recycled_units += recycled;
        r.outstanding_units += Math.max(0, qty - listed - recycled);
        if (!it.recycle_only) {
          r.total_value += parseNum(it.value) * qty;
          r.total_offer += parseNum(it.offer) * qty;
          r.total_cost  += parseNum(it.cost) * qty;
        }
      });
    }

    return jsonResponse({
      success: true,
      data: (deals || []).map((d: any) => ({
        ...d,
        ref: dealRef(d.client?.acronym || "B2B", d.deal_no),
        ...(roll[d.id] || {
          total_value: 0, total_offer: 0, total_cost: 0, total_units: 0,
          line_count: 0, listed_units: 0, recycled_units: 0, outstanding_units: 0,
        }),
      })),
    });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message }, 500);
  }
});
