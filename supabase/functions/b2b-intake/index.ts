import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Live bench intake. A capture tool running on the laptop being tested posts its
// own specs here; they queue against an open session and reach the pricing sheet
// only when a person accepts them.
//
// WHAT THIS FUNCTION DOES NOT DO: write b2b_deal_items. Accepting calls
// b2b-deals add_item/update_item over HTTP rather than inserting directly, so
// SKU minting, line numbering, sort_order, the stage gates, the spec/serial
// validation and the realtime broadcast all stay in the one function that has
// always owned them. Two writers to that table would drift within a release,
// and the drift would be silent and would be money.
//
// Tables: b2b_intake_sessions + b2b_intake_submissions (see 0065).
//
// DEPLOY WITH --no-verify-jwt, the same as b2b-deals:
//
//   supabase functions deploy b2b-intake --no-verify-jwt
//
// Neither caller sends an Authorization header. The sheet posts the way
// _b2bSend does (content-type only, so the request stays simple and skips the
// CORS preflight), and the bench tool is a bare PowerShell Invoke-RestMethod on
// a machine that has never signed in to anything. Deployed with JWT
// verification on, every call here 401s before a line of this file runs -- and
// the symptom on the bench reads as a network fault, not a config one.

// The join code's alphabet. No 0/O, no 1/I/L: this gets read off a screen across
// a bench and typed into a laptop, and those are the pairs people get wrong.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

// How long a session stays live without anybody closing it. Long enough for a
// full bench day, short enough that a stick left plugged in overnight cannot
// post into the deal tomorrow morning.
const SESSION_HOURS = 12;

// Mirrors OPEN_STAGES in b2b-deals: line items may only be added while the deal
// is being priced or quoted. A session cannot be opened against anything else,
// and accepting re-checks -- the deal can move on while a session is live.
const OPEN_STAGES = ["pricing", "quote"];

// Mirrors ITEM_TYPES and B2B_CONDITIONS. 'For Parts' is absent on purpose: it is
// the retired spelling of 'Broken' (see B2B_COND_LEGACY in speeks.js) and
// nothing new should be created carrying it.
const ITEM_TYPES = ["computer", "laptop", "desktop", "other"];
const CONDITIONS = ["New", "Like New", "Good", "Fair", "Broken"];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class Invalid extends Error {}

function str(v: unknown, max: number, label: string, required = false): string | null {
  const s = String(v ?? "").trim();
  if (!s) {
    if (required) throw new Invalid(label + " is required.");
    return null;
  }
  if (s.length > max) throw new Invalid(label + " is too long (max " + max + ").");
  return s;
}

function newCode(): string {
  let out = "";
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

// Same broadcast the rest of the B2B pipeline uses, so an accepted line and a
// newly arrived submission both repaint an open sheet through the existing
// _RT_TOOL_CHECKS['b2b'] wiring. Best-effort: never let it break a write.
async function broadcastChange(about?: { deal?: string | null; by?: string | null }) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(url + "/realtime/v1/api/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: "Bearer " + key },
      body: JSON.stringify({
        messages: [{
          topic: "speeks-notify",
          event: "changed",
          payload: { tool: "b2b", deal: about?.deal ?? null, by: about?.by ?? null },
        }],
      }),
    });
  } catch (_) { /* the write already committed */ }
}

// The single writer to b2b_deal_items is b2b-deals. This is the door to it.
async function callDeals(body: Record<string, unknown>): Promise<any> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(url + "/functions/v1/b2b-deals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: "Bearer " + key,
    },
    body: JSON.stringify(body),
  });
  let out: any = null;
  try { out = JSON.parse(await res.text()); } catch (_) { out = null; }
  if (!out) throw new Invalid("The deals service did not answer. Nothing was changed.");
  if (out.success === false) throw new Invalid(String(out.error || "The line could not be saved."));
  return out;
}

// ---------------------------------------------------------------- the payload

// PowerShell 5.1 writes a UTF-8 BOM on every file it creates, and if the capture
// tool ever posts a file's bytes rather than a rebuilt string, that BOM arrives
// at the front of the body and JSON.parse throws on it. Cheap to strip, and the
// alternative is a failure mode that reads as "the network is broken".
// Written as the escape rather than a literal BOM: an invisible character is
// one a later edit, a copy-paste or a re-encode can silently drop, and losing
// it would bring back exactly the bug this line exists to stop.
function parseBody(raw: string): any {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

// eBay category per item type. Ported from Get-EbayLinks in SPEEKS-Collate.ps1
// so a line created live and the same line created through the USB/collate route
// carry an identical listing_info -- if these two drift, one machine gets two
// different comp searches depending on which door it came through.
const EBAY_CATEGORY: Record<string, string> = {
  laptop: "177", computer: "177", desktop: "179", other: "",
};

function listingInfoFrom(capture: any): string | null {
  const bits: string[] = [];
  const screen = String(capture?.detail?.screen_text ?? "").trim();
  if (screen) bits.push("Screen: " + screen);
  const battery = String(capture?.battery_health ?? "").trim();
  if (battery) bits.push("Battery: " + battery);

  const focused = [capture.make, capture.model, capture.cpu, capture.ram]
    .map((x: unknown) => String(x ?? "").trim()).filter(Boolean).join(" ");
  if (focused) {
    const cat = EBAY_CATEGORY[String(capture.item_type ?? "")] ?? "";
    const enc = encodeURIComponent(focused);
    bits.push(
      "Pricing: https://www.ebay.com/sh/research?marketplace=EBAY-US&tabName=SOLD" +
      "&keywords=" + enc + "&dayRange=90&categoryId=" + cat +
      "&offset=0&limit=50&sorting=match",
    );
  }
  return bits.length ? bits.join(" | ") : null;
}

// Normalise one capture into the b2b_deal_items shape. The capture tool already
// speaks this schema -- see its README -- so this is mostly bounds-checking
// rather than translation.
function itemFieldsFrom(capture: any): Record<string, unknown> {
  const itemType = ITEM_TYPES.includes(String(capture.item_type ?? ""))
    ? String(capture.item_type)
    : "other";

  // Condition is the one field a person answered rather than a machine read, and
  // it is the one that can arrive unusable. An unrecognised value (including the
  // retired 'For Parts') becomes null rather than being forced to something
  // plausible: a blank condition is visible on the sheet and gets fixed, where a
  // wrong one silently prices the machine.
  const rawCond = String(capture.condition ?? "").trim();
  const condition = CONDITIONS.includes(rawCond) ? rawCond : null;

  return {
    make: str(capture.make, 120, "Brand"),
    model: str(capture.model, 200, "Model"),
    item_type: itemType,
    condition,
    cpu: str(capture.cpu, 60, "CPU"),
    ram: str(capture.ram, 60, "RAM"),
    storage: str(capture.storage, 60, "Storage"),
    gpu: str(capture.gpu, 60, "GPU"),
    battery_health: str(capture.battery_health, 60, "Battery health"),
    staff_notes: str(capture.staff_notes, 1000, "Staff notes"),
    client_notes: str(capture.client_notes, 1000, "Client notes"),
    listing_info: str(listingInfoFrom(capture), 2000, "Listing info"),
    wipe_required: capture.wipe_required === true,
    disposition: "purchase",
  };
}

// THE roll-up key, ported from SPEEKS-Collate.ps1's $key. Same nine fields, same
// order, same lowercasing.
//
// Screen and battery health are deliberately absent. A laptop tested on a dock
// reports the dock's panel and one tested off it reports its own; battery is a
// range. Either would split an otherwise identical pallet into singleton lines,
// which is the failure this key exists to prevent. Both still travel in
// listing_info, where they inform without fragmenting.
function rollupKey(f: Record<string, unknown>): string {
  return [
    f.make, f.model, f.item_type, f.cpu, f.ram, f.storage, f.gpu,
    f.condition, f.wipe_required === true ? "true" : "false",
  ].map((x) => String(x ?? "").trim().toLowerCase()).join("|");
}

function serialList(v: unknown): string[] {
  return String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST only." }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = parseBody(await req.text());
    const action = String(body.action ?? "");

    // ============================================================== sessions

    if (action === "open_session") {
      const dealId = str(body.deal_id, 64, "Deal", true)!;
      const { data: deal } = await supabase.from("b2b_deals")
        .select("id, stage").eq("id", dealId).maybeSingle();
      if (!deal) return jsonResponse({ success: false, error: "That deal no longer exists." }, 404);
      if (!OPEN_STAGES.includes(deal.stage)) {
        return jsonResponse({
          success: false,
          error: "Devices can only report in while the deal is being priced or quoted.",
        }, 409);
      }

      // Re-opening while one is already live returns the SAME code rather than
      // minting a second. Clicking the button twice is a normal thing to do, and
      // a fresh code would silently orphan every stick already talking to it.
      const { data: live } = await supabase.from("b2b_intake_sessions")
        .select("*").eq("deal_id", dealId).eq("status", "open").maybeSingle();
      if (live && new Date(live.expires_at) > new Date()) {
        return jsonResponse({ success: true, session: live, reused: true });
      }
      // Expired but never closed: close it now so the partial unique index frees.
      if (live) {
        await supabase.from("b2b_intake_sessions")
          .update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", live.id);
      }

      const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
      // Codes are random and unique-indexed, so a collision is possible and must
      // not surface as a 500 to someone clicking a button. Retry a few times;
      // 31^6 is ~887 million, so this effectively never runs twice.
      let session: any = null;
      for (let attempt = 0; attempt < 5 && !session; attempt++) {
        const { data, error } = await supabase.from("b2b_intake_sessions").insert({
          deal_id: dealId,
          code: newCode(),
          opened_by: str(body.user, 80, "User"),
          expires_at: expires,
        }).select("*").single();
        if (!error) { session = data; break; }
        if (!String(error.message).toLowerCase().includes("duplicate")) {
          return jsonResponse({ success: false, error: error.message }, 500);
        }
      }
      if (!session) {
        return jsonResponse({ success: false, error: "Couldn't allocate a code. Try again." }, 500);
      }

      await broadcastChange({ deal: dealId, by: str(body.user, 80, "User") });
      return jsonResponse({ success: true, session });
    }

    if (action === "close_session") {
      const dealId = str(body.deal_id, 64, "Deal", true)!;
      const { error } = await supabase.from("b2b_intake_sessions")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("deal_id", dealId).eq("status", "open");
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      await broadcastChange({ deal: dealId, by: str(body.user, 80, "User") });
      return jsonResponse({ success: true });
    }

    // What the sheet draws: the live session (if any) and everything waiting on
    // a decision, each already carrying what accepting it WOULD do.
    if (action === "tray") {
      const dealId = str(body.deal_id, 64, "Deal", true)!;
      const { data: session } = await supabase.from("b2b_intake_sessions")
        .select("*").eq("deal_id", dealId).eq("status", "open").maybeSingle();

      let pending: any[] = [];
      if (session) {
        const { data } = await supabase.from("b2b_intake_submissions")
          .select("*").eq("session_id", session.id).eq("status", "pending")
          .order("received_at", { ascending: true });
        pending = data || [];
      }

      // Resolve each pending row against the deal's current lines so the tray can
      // say "+1 to line 4" rather than making the pricer work it out.
      const { data: items } = await supabase.from("b2b_deal_items")
        .select("id, line_no, make, model, item_type, cpu, ram, storage, gpu, condition, wipe_required, quantity, serials")
        .eq("deal_id", dealId).order("line_no", { ascending: true });
      // First match by line number wins, and both here and in accept below the
      // rows are ordered the same way. Nothing stops a sheet holding two lines
      // with an identical key -- somebody can always add one by hand -- and if
      // the tray promised "+1 to line 7" while accept found line 2 first, the
      // unit would land somewhere the pricer was not told about.
      const byKey = new Map<string, any>();
      for (const it of items || []) {
        const k = rollupKey(it);
        if (!byKey.has(k)) byKey.set(k, it);
      }

      const rows = pending.map((p) => {
        const fields = itemFieldsFrom(p.payload || {});
        const match = byKey.get(rollupKey(fields)) || null;
        const dupSerial = (items || []).some((it) =>
          serialList(it.serials).some((s) => s.toLowerCase() === String(p.serial).toLowerCase()));
        return {
          id: p.id,
          serial: p.serial,
          device: p.device,
          // The stick. Shown in the tray so "which drive did that come off" has
          // an answer while three people are working one pallet.
          device_id: p.device_id,
          device_label: p.device_label,
          received_at: p.received_at,
          fields,
          // null => a new line; otherwise the line this would join.
          match: match ? { id: match.id, line_no: match.line_no, quantity: match.quantity } : null,
          // Already on the sheet under this serial. Accepting would break the
          // serials-per-unit rule, so the tray warns instead of offering it.
          duplicate: dupSerial,
        };
      });

      return jsonResponse({
        success: true,
        session: session || null,
        expired: session ? new Date(session.expires_at) <= new Date() : false,
        pending: rows,
      });
    }

    // ================================================== the device-facing door

    // The ONLY action a bench machine calls, and the only one that is not
    // operated by a signed-in person. Its credential is the session code, which
    // is short-lived, scoped to one deal, revocable, and -- because everything it
    // creates is inert until accepted -- cannot by itself move a penny.
    if (action === "submit") {
      const code = String(body.code ?? "").trim().toUpperCase();
      if (!code) return jsonResponse({ success: false, error: "No session code." }, 400);

      const { data: session } = await supabase.from("b2b_intake_sessions")
        .select("*").eq("code", code).maybeSingle();
      // One message for "wrong code" and "closed code" alike. A bench tool is not
      // a place to explain which guesses were closer.
      if (!session || session.status !== "open" || new Date(session.expires_at) <= new Date()) {
        return jsonResponse({ success: false, error: "That session isn't open." }, 403);
      }

      const capture = body.capture ?? {};
      const serial = str(capture.serial, 120, "Serial", true)!;
      // Validate before storing: a payload that cannot become a line is worth
      // rejecting at the door, where the tester is still standing next to the
      // machine and can do something about it.
      itemFieldsFrom(capture);

      // Which STICK, not which machine. The envelope first, then the record, so
      // a stick running an older build -- which sends neither -- still works and
      // simply reports no device.
      const deviceId = str(body.device_id ?? capture.device_id, 64, "Device id");
      const deviceLabel = str(body.device_label ?? capture.device_label, 80, "Device label");

      // Upsert on (session_id, serial) -- a re-test replaces its earlier reading
      // rather than queueing a second one. Deliberately resets an already-decided
      // row back to pending: if a machine is tested again after its line was
      // accepted, that is new information and wants a fresh decision.
      const { error } = await supabase.from("b2b_intake_submissions").upsert({
        session_id: session.id,
        serial,
        payload: capture,
        device: str(capture.captured_on, 120, "Device"),
        device_id: deviceId,
        device_label: deviceLabel,
        status: "pending",
        item_id: null,
        decided_by: null,
        decided_at: null,
        received_at: new Date().toISOString(),
      }, { onConflict: "session_id,serial" });
      if (error) return jsonResponse({ success: false, error: error.message }, 500);

      await broadcastChange({ deal: session.deal_id, by: str(capture.captured_on, 80, "Device") });
      return jsonResponse({ success: true, queued: true, serial });
    }

    // ================================================================ decisions

    if (action === "accept" || action === "reject") {
      const id = str(body.id, 64, "Submission", true)!;
      const who = str(body.user, 80, "User");
      const { data: sub } = await supabase.from("b2b_intake_submissions")
        .select("*, session:b2b_intake_sessions(id, deal_id, status)").eq("id", id).maybeSingle();
      if (!sub) return jsonResponse({ success: false, error: "That submission is gone." }, 404);
      if (sub.status !== "pending") {
        return jsonResponse({ success: false, error: "That one has already been dealt with." }, 409);
      }
      const dealId = sub.session?.deal_id;

      if (action === "reject") {
        await supabase.from("b2b_intake_submissions")
          .update({ status: "rejected", decided_by: who, decided_at: new Date().toISOString() })
          .eq("id", id);
        await broadcastChange({ deal: dealId, by: who });
        return jsonResponse({ success: true });
      }

      const fields = itemFieldsFrom(sub.payload || {});

      // Re-resolve the match at accept time rather than trusting what the tray
      // was drawn with. Between the sheet rendering and the click, someone else
      // may have accepted the identical machine, edited a spec, or deleted the
      // line -- and the stale answer would either duplicate a line or write to
      // one that no longer exists.
      const { data: items } = await supabase.from("b2b_deal_items")
        .select("id, line_no, make, model, item_type, cpu, ram, storage, gpu, condition, wipe_required, quantity, serials, staff_notes, client_notes, listing_info, value, offer, shipping_cost, disposition, wipe_fee")
        // Ordered to agree with the tray, so the line accept picks is the line
        // the pricer was shown. See the note there.
        .eq("deal_id", dealId).order("line_no", { ascending: true });

      // A serial already on the sheet means this unit is counted. Accepting again
      // would put the line's serial count out of step with its quantity, and
      // submit_pricing would then refuse the whole deal (unserialledNames).
      const already = (items || []).find((it) =>
        serialList(it.serials).some((s) => s.toLowerCase() === String(sub.serial).toLowerCase()));
      if (already) {
        return jsonResponse({
          success: false,
          error: "Serial " + sub.serial + " is already on line " + already.line_no + ".",
        }, 409);
      }

      const forceNew = body.force_new === true;
      const match = forceNew
        ? null
        : (items || []).find((it) => rollupKey(it) === rollupKey(fields)) || null;

      let itemId: string;
      if (match) {
        // Roll up: one more unit, and its serial joins the pool. Everything the
        // pricer has already typed on that line -- value, offer, notes -- is left
        // exactly as it is; a new unit arriving must never reprice a line.
        const serials = serialList(match.serials);
        serials.push(String(sub.serial));
        await callDeals({
          action: "update_item",
          id: match.id,
          user: who,
          ...fields,
          // Preserve the line's own pricing and prose over the capture's.
          staff_notes: match.staff_notes,
          client_notes: match.client_notes,
          listing_info: match.listing_info,
          disposition: match.disposition,
          value: match.value,
          offer: match.offer,
          shipping_cost: match.shipping_cost,
          // Without this, update_item re-reads the CURRENT global wipe fee and
          // re-snapshots the line at it (see wipeFeeNow in b2b-deals). A unit
          // arriving on the bench would then silently reprice a line the client
          // may already have been quoted -- exactly what the snapshot exists to
          // prevent. The sheet passes the same field on every edit.
          keep_wipe_fee: match.wipe_fee,
          quantity: (Number(match.quantity) || 1) + 1,
          serials: serials.join(","),
        });
        itemId = match.id;
      } else {
        const out = await callDeals({
          action: "add_item",
          deal_id: dealId,
          user: who,
          ...fields,
          quantity: 1,
          serials: String(sub.serial),
        });
        itemId = String(out.id);
      }

      await supabase.from("b2b_intake_submissions").update({
        status: "accepted",
        item_id: itemId,
        decided_by: who,
        decided_at: new Date().toISOString(),
      }).eq("id", id);

      await broadcastChange({ deal: dealId, by: who });
      return jsonResponse({ success: true, item_id: itemId, rolled_up: !!match });
    }

    return jsonResponse({ success: false, error: "Unknown action: " + action }, 400);
  } catch (e) {
    if (e instanceof Invalid) return jsonResponse({ success: false, error: e.message }, 400);
    return jsonResponse({ success: false, error: String((e as Error)?.message || e) }, 500);
  }
});
