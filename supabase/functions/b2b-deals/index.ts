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
//   quote             corp    email the quote; stays editable while the client
//                             negotiates; CEO/TOM/DM alone may accept it
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

// Gmail relay (Apps Script web app) — same sender the weekly report uses, so
// quotes go out over an already-proven path with no DNS work.
const SECRET      = "sp33ks-sync-k3y-2026-x9mq";
const RESEND_URL  = "https://api.resend.com/emails";
const FROM        = Deno.env.get("RESEND_FROM") || "Speeks Quotes <onboarding@resend.dev>";
const GMAIL_RELAY = Deno.env.get("GMAIL_RELAY_URL") ||
  "https://script.google.com/macros/s/AKfycby4Y2l3DJ6fQCrpFuwTTXKeaD3QV5DbLhf7jmberZCUFx86VaaE6vb9Bs_CweNh3K9VtQ/exec";

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

// ---------------------------------------------------------------- quote email

const money = (n: number) =>
  "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Email-safe: 600px, table layout, every style inline. No external CSS, no
// flexbox, no web fonts — Outlook renders none of it.
function quoteEmailHtml(deal: any, items: any[]) {
  const c = deal.client || {};
  const ref = dealRef(c.acronym || "B2B", deal.deal_no);
  const total = items.reduce(
    (s, it) => s + (it.recycle_only ? 0 : parseNum(it.offer) * parseInt0(it.quantity)),
    0,
  );
  const today = new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago",
  });

  const rows = items.map((it) => {
    const qty = parseInt0(it.quantity) || 1;
    const line = it.recycle_only ? null : parseNum(it.offer) * qty;
    const bits = [it.condition, it.client_notes].filter(Boolean).map(esc).join(" &middot; ");
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #eef2f6;font-size:13px;color:#1a1c1e;">
          <b>${esc([it.make, it.model].filter(Boolean).join(" ") || "Item")}</b>
          ${it.recycle_only ? '<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;background:#eef2f6;color:#647082;font-size:10px;font-weight:700;">RECYCLE</span>' : ""}
          ${bits ? `<div style="margin-top:3px;font-size:11.5px;color:#647082;">${bits}</div>` : ""}
          <div style="margin-top:3px;font-size:10.5px;color:#94a3b8;letter-spacing:.04em;">${esc(it.sku || "")}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #eef2f6;font-size:13px;color:#1a1c1e;text-align:center;">${qty}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eef2f6;font-size:13px;color:#1a1c1e;text-align:right;">${it.recycle_only ? "&mdash;" : money(parseNum(it.offer))}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eef2f6;font-size:13px;color:#1a1c1e;text-align:right;font-weight:700;">${line === null ? "&mdash;" : money(line)}</td>
      </tr>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f4f7f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" align="center" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e6ebf1;border-radius:14px;overflow:hidden;">
  <tr>
    <td style="padding:22px 24px;border-bottom:1px solid #eef2f6;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:21px;font-weight:800;color:#1a1c1e;letter-spacing:-.4px;">Pay<span style="color:#1f9d57;">More</span>
          <div style="margin-top:2px;font-size:11px;font-weight:600;color:#647082;letter-spacing:.02em;">Buy &middot; Sell &middot; Recycle Electronics</div>
        </td>
        <td align="right" style="font-size:12px;color:#647082;">
          <div style="font-size:15px;font-weight:800;color:#1a1c1e;">Quote</div>
          <div style="margin-top:3px;">${esc(ref)}</div>
          <div>${esc(today)}</div>
        </td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding:18px 24px;background:#f6f8fa;border-bottom:1px solid #eef2f6;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:12px;color:#647082;vertical-align:top;">
          <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#94a3b8;">Prepared for</div>
          <div style="margin-top:4px;font-size:14px;font-weight:700;color:#1a1c1e;">${esc(c.company || "")}</div>
          ${c.contact ? `<div style="margin-top:2px;">${esc(c.contact)}</div>` : ""}
        </td>
        <td align="right" style="font-size:12px;color:#647082;vertical-align:top;">
          <div style="font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#94a3b8;">Issued by</div>
          <div style="margin-top:4px;font-size:14px;font-weight:700;color:#1a1c1e;">SPEEKS Technology</div>
          <div style="margin-top:2px;">Authorized PayMore franchisee</div>
          ${deal.pickup_date ? `<div style="margin-top:2px;">Picked up ${esc(deal.pickup_date)}</div>` : ""}
        </td>
      </tr></table>
    </td>
  </tr>
  <tr><td style="padding:0 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
      <tr>
        <th align="left"   style="padding:10px 12px;border-bottom:2px solid #e6ebf1;font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#647082;">Description</th>
        <th align="center" style="padding:10px 12px;border-bottom:2px solid #e6ebf1;font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#647082;">Qty</th>
        <th align="right"  style="padding:10px 12px;border-bottom:2px solid #e6ebf1;font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#647082;">Unit offer</th>
        <th align="right"  style="padding:10px 12px;border-bottom:2px solid #e6ebf1;font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#647082;">Line total</th>
      </tr>
      ${rows}
      <tr>
        <td colspan="3" align="right" style="padding:14px 12px;font-size:13px;font-weight:800;color:#1a1c1e;">Total offer</td>
        <td align="right" style="padding:14px 12px;font-size:17px;font-weight:800;color:#178048;">${money(total)}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:6px 24px 24px;font-size:11.5px;color:#94a3b8;line-height:1.6;">
    Reply to this email to accept the quote or ask about any line.
    Recycle-only items carry no offer and are disposed of responsibly at no cost to you.
  </td></tr>
</table>
</body></html>`;
}

async function sendEmail(to: string[], subject: string, html: string) {
  if (GMAIL_RELAY) {
    const res = await fetch(GMAIL_RELAY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SECRET, to: to.join(","), subject, html }),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
  }
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, error: "No GMAIL_RELAY_URL or RESEND_API_KEY set" };
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
}

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

        // add_item — next line number for this deal. Lines added mid-quote get
        // their SKU straight away so a label can be printed for them.
        const { data: last } = await supabase.from("b2b_deal_items")
          .select("line_no").eq("deal_id", deal.id)
          .order("line_no", { ascending: false }).limit(1).maybeSingle();
        const lineNo = (last?.line_no || 0) + 1;
        const acronym = deal.client?.acronym || "B2B";
        const { data, error } = await supabase.from("b2b_deal_items").insert({
          ...fields,
          deal_id: deal.id,
          line_no: lineNo,
          sku: deal.stage === "quote" ? skuFor(acronym, deal.deal_no, lineNo) : null,
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
          .select("id, line_no, sku").eq("deal_id", deal.id).order("line_no", { ascending: true });
        if (!items?.length) return jsonResponse({ success: false, error: "Add at least one line item before submitting." }, 400);

        // SKUs are assigned here so labels can be printed during quoting; they
        // are frozen for good once the quote is accepted.
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

      if (action === "send_quote") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "quote") return jsonResponse({ success: false, error: "Only a deal in the quote stage can be emailed." }, 409);
        const to = (txt(body.to) || deal.client?.contact_email || "").split(",").map((s: string) => s.trim()).filter(Boolean);
        if (!to.length) return jsonResponse({ success: false, error: "No email address on file for this client." }, 400);

        const { data: items } = await supabase.from("b2b_deal_items")
          .select("*").eq("deal_id", deal.id).order("line_no", { ascending: true });
        const ref = dealRef(deal.client?.acronym || "B2B", deal.deal_no);
        const sent = await sendEmail(
          to,
          `Your PayMore quote ${ref}`,
          quoteEmailHtml(deal, items || []),
        );
        if (!sent.ok) {
          return jsonResponse({ success: false, error: `The quote couldn't be emailed: ${sent.error || sent.body || sent.status}` }, 502);
        }
        const { error } = await supabase.from("b2b_deals").update({
          quote_sent_at: new Date().toISOString(),
          quote_send_count: (deal.quote_send_count || 0) + 1,
          ...touch(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true, to });
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
          .select("id, line_no, sku, offer").eq("deal_id", deal.id).order("line_no", { ascending: true });
        if (!items?.length) return jsonResponse({ success: false, error: "This quote has no line items." }, 400);

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
