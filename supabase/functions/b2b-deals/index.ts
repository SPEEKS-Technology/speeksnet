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
//   pricing           store   itemize and price: type, specs, one serial per
//                             unit, a disposition, and whether it needs a
//                             certified data wipe
//   review            corp    priced and waiting on a CEO/TOM/DM: they either
//                             send it (which approves it) or send it back to
//                             pricing with a note. The approver is emailed the
//                             moment it lands here
//   quote             corp    emailed to the client, waiting on their answer.
//                             Goes out from the quoter's own mailbox as a mailto
//                             draft so replies reach them. Both stages stay
//                             editable, and only a CEO/TOM/DM may send, accept
//                             or send back
//
//                             These were one stage until 0018, told apart by
//                             quote_send_count. One counter standing in for two
//                             states was read in five places in the UI, made the
//                             Overview contradict its own table, and meant a
//                             send-back had to remember to reset it
//   listing_location  corp    ONLY when pricing happened at CORP
//   listing           store   two scans per unit -- our label says which unit,
//                             the Shopify barcode records what it became; a
//                             line quoted for a certified wipe must be ticked
//                             wiped before its units can go up; bad units get
//                             recycled out instead
//   completed         —       terminal, the deal ran its course
//   declined          —       terminal, the deal died; reachable any time
//                             before listing, since once a quote is accepted
//                             the goods are already ours
//
// Reads come from the b2b_deal_list / b2b_client_list views, which roll the
// line items up in Postgres. Summing them here meant transferring every item
// on every board draw, which does not survive thousands of them.
//
// Authorization is client-side (PIN trust model, matching the rest of the app);
// what THIS function enforces is legal state transitions and input validity,
// so a stale tab or a hand-rolled request can't corrupt a pipeline.
// Tables: b2b_clients + b2b_deals + b2b_deal_items + b2b_item_listings.

// Shared with the other B2B functions and the cron jobs. Same value as
// b2b-outreach's, which is what lets this function ask it to send a mail.
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const PRICING_LOCATIONS = [...STORES, "CORP"];
const ACCEPT_ROLES = ["ceo", "tom", "district manager"];
// 'For Parts' was renamed to 'Broken' -- same meaning, plainer word. The old
// spelling stays recognised here: existing rows were migrated, but a row saved
// between this deploying and that running would otherwise stop being asked for
// a reason, and it would stop silently. Must match B2B_REASON_CONDITIONS in
// speeks.js -- if these two disagree, the gate passes on one side and fails on
// the other.
const REASON_CONDITIONS = ["Fair", "Broken", "For Parts"];
const DECLINE_CATEGORIES = ["client_declined", "client_unresponsive", "withdrawn", "not_viable", "other"];
const TERMINAL = ["completed", "declined"];

// How many finished deals ride along with the open ones. The board only ever
// shows the recent tail; the full history is paged for explicitly.
const ARCHIVE_DEFAULT = 40;
const ARCHIVE_MAX = 500;

// Must stay in step with the b2b_stage_rank() SQL function, which three CHECK
// constraints use to decide what a row at a given stage is required to have.
const STAGE_RANK: Record<string, number> = {
  declined: 0, pickup: 1, pricing_location: 2, pricing: 3,
  review: 4, quote: 5, listing_location: 6, listing: 7, completed: 8,
};
// The two stages where line items stay editable alongside pricing: a quote is
// negotiable right up until someone accepts it.
const OPEN_STAGES = ["pricing", "review", "quote"];

// The column list the board needs. Selecting * from a view with rollups drags
// along everything; naming them keeps the payload predictable.
const DEAL_COLS = [
  "id", "client_id", "deal_no", "ref", "stage", "stage_rank", "is_terminal",
  "pickup_desc", "signed_by", "signed_at", "pickup_date",
  "pricing_store", "listing_store", "delivered_by", "received_by",
  "priced_by", "quote_sent_at", "quote_send_count", "accepted_at", "accepted_by",
  "declined_at", "declined_by", "declined_reason", "declined_category",
  "sendback_note", "sendback_by", "sendback_at",
  "signature_path", "signature_at", "signature_by",
  "signature_skipped_by", "signature_skipped_reason",
  "created_by", "created_at", "updated_at", "stage_changed_at",
  "company", "acronym", "contact", "contact_email", "contact_phone",
  "line_count", "total_units", "listed_units", "recycled_units", "outstanding_units",
  "wiped_units", "total_value", "total_offer", "total_cost", "total_wipe_fee", "net_offer",
  "total_shipping", "wipe_units",
].join(",");

// Who to ring at the client. Corp business: a store prices and lists the goods,
// it never contacts the client, and every screen that shows these is already
// gated on _b2bIsCorp(). Hiding them in the UI while still shipping them to the
// browser only hides them from the person, not from the page -- so a request
// scoped to one store gets the board without them.
const CONTACT_COLS = ["contact", "contact_email", "contact_phone"];
const SCOPED_DEAL_COLS = DEAL_COLS.split(",")
  .filter((c) => !CONTACT_COLS.includes(c)).join(",");

const ITEM_COLS = [
  "id", "deal_id", "line_no", "sku", "make", "model", "condition",
  "staff_notes", "client_notes", "quantity", "value", "offer", "cost",
  "disposition", "listed_qty", "recycled_qty", "created_at",
  "item_type", "cpu", "ram", "storage", "gpu", "battery_health", "serials",
  "wipe_required", "wipe_fee", "wiped_qty", "shipping_cost", "sort_order",
].join(",");

// `computer` folds the old laptop/desktop split into one type; the legacy two
// stay accepted so a not-yet-migrated row can still save.
const ITEM_TYPES = ["computer", "laptop", "desktop", "other"];
const DISPOSITIONS = ["purchase", "no_residual", "recycle"];
// Which spec fields each type carries. `other` carries none -- a box of cables
// has no CPU, and the CHECK on the table refuses one.
const SPECS_FOR: Record<string, string[]> = {
  computer: ["cpu", "ram", "storage", "gpu", "battery_health"],
  laptop: ["cpu", "ram", "storage", "gpu", "battery_health"],
  desktop: ["cpu", "ram", "storage", "gpu"],
  other: [],
};
// The subset you cannot price without. GPU is optional (integrated graphics are
// the norm) and so is battery health (a dead battery reports nothing).
const SPECS_REQUIRED = ["cpu", "ram", "storage"];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ------------------------------------------------------------- validation
// Every limit here mirrors a CHECK constraint on the table. The database is
// the backstop; this exists so a user gets "Model is too long" instead of a
// 500 with a constraint name in it.

class Invalid extends Error {}

function str(v: unknown, max: number, label: string, required = false): string | null {
  const s = String(v ?? "").trim();
  if (!s) {
    if (required) throw new Invalid(`${label} is required.`);
    return null;
  }
  if (s.length > max) throw new Invalid(`${label} is too long (max ${max} characters).`);
  return s;
}

// numeric(12,2) — round rather than reject, but refuse anything absurd so a
// slipped keypress can't poison every rollup that reads the column.
function money(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) throw new Invalid(`${label} can't be negative.`);
  if (n > 9999999) throw new Invalid(`${label} is unrealistically large.`);
  return Math.round(n * 100) / 100;
}

function count(v: unknown, lo: number, hi: number, label: string, dflt: number): number {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new Invalid(`${label} must be a number.`);
  if (n < lo || n > hi) throw new Invalid(`${label} must be between ${lo} and ${hi}.`);
  return n;
}

// Number(null) is 0, not NaN -- an absent query param would otherwise read as
// a deliberate zero and silently cap the archive to nothing.
function intOr(v: unknown, dflt: number): number {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : dflt;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function email(v: unknown, label: string): string | null {
  const s = str(v, 200, label);
  if (s && !EMAIL.test(s)) throw new Invalid(`${label} doesn't look like an email address.`);
  return s;
}

// A date column will happily take garbage and fail deep in Postgres; catching
// the shape here keeps the error readable.
function isoDate(v: unknown, label: string, required = false): string | null {
  const s = str(v, 10, label, required);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) {
    throw new Invalid(`${label} must be a real date.`);
  }
  return s;
}

function oneOf(v: unknown, allowed: string[], label: string, required = true): string | null {
  const s = String(v ?? "").trim();
  if (!s) {
    if (required) throw new Invalid(`${label} is required.`);
    return null;
  }
  if (!allowed.includes(s)) throw new Invalid(`${label} isn't a valid option.`);
  return s;
}

// A Shopify listing barcode: exactly 8 digits, mirroring the CHECK on
// b2b_item_listings. Strictness is the feature -- it is what stops one of our
// own SKUs (ACM-001-0002), mis-scanned into the same field, being stored as a
// Shopify barcode and quietly marking a unit live that never went live.
function barcode8(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) throw new Invalid("A Shopify barcode is required to list a unit.");
  if (!/^\d{8}$/.test(s)) {
    throw new Invalid(`"${s.slice(0, 24)}" isn't a Shopify barcode — it should be exactly 8 digits.`);
  }
  return s;
}

async function itemListings(supabase: any, itemId: string) {
  const { data } = await supabase.from("b2b_item_listings")
    .select("id,item_id,shopify_barcode,listed_by,listed_at").eq("item_id", itemId)
    .order("listed_at", { ascending: true }).limit(10000);
  return data || [];
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const skuFor = (acronym: string, dealNo: number, lineNo: number) =>
  `${acronym}-${pad(dealNo, 3)}-${pad(lineNo, 4)}`;

// Realtime "ping": after a successful write, tell any signed-in client that this
// tool changed so it can re-run its check (which re-fetches through THIS function
// — no table data ever travels over realtime, so the RLS-locked tables stay
// closed to the anon client). The store is a hint for client-side filtering.
// Wrapped so a broadcast failure can never break the write it follows.
// `about` carries which deal moved and who moved it. Two people pricing one
// pallet both have the sheet open, and without it every write meant either
// refetching on any B2B change anywhere or -- what actually happened -- dropping
// the change entirely. Both fields are hints for the client and nothing more:
// no table data travels over realtime.
async function broadcastChange(
  tool: string,
  store: string | null,
  about?: { deal?: string | null; by?: string | null },
) {
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
          payload: {
            tool,
            store: store ? String(store).toUpperCase() : null,
            deal: about?.deal || null,
            by: about?.by || null,
            ts: Date.now(),
          },
        }],
      }),
    });
  } catch (_) {
    // swallow — the write already succeeded; realtime is best-effort
  }
}

// What we charge per device for a certified data wipe. Resolved here rather
// than taken from the request: the browser that flags a line may be a tab left
// open since before the fee changed, and the figure it snapshots onto the item
// is the one the client is quoted.
async function wipeFeeNow(sb: any): Promise<number> {
  try {
    const { data } = await sb.from("b2b_crm_settings").select("wipe_fee").eq("id", 1).maybeSingle();
    const n = Number(data?.wipe_fee);
    return Number.isFinite(n) && n >= 0 ? n : 8;
  } catch (_) {
    return 8;
  }
}

// Tell the approver a quote is waiting on them. The mail itself is built and
// sent by b2b-outreach, which already owns the settings row, the relay and the
// email styling -- duplicating any of that here would give us two versions of
// the same email to keep in step.
//
// Wrapped exactly like broadcastChange: the submit has already committed by the
// time this runs, so nothing it does may throw.
async function notifyQuoteReady(dealId: string) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    await fetch(`${url}/functions/v1/b2b-outreach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "notify_quote_ready", deal_id: dealId, secret: SECRET }),
    });
  } catch (_) {
    // swallow — the stage change already succeeded; the email is best-effort
  }
}

// updated_at and stage_changed_at are maintained by the b2b_touch_row trigger,
// so no write here has to remember them.
async function getDeal(sb: any, id: string) {
  if (!id) throw new Invalid("A deal id is required.");
  const { data, error } = await sb
    .from("b2b_deals")
    .select("*, client:b2b_clients(id, company, acronym, contact, contact_email)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

const dealStore = (d: any) => d?.listing_store || d?.pricing_store || null;

const lineName = (it: any) =>
  [it.make, it.model].filter(Boolean).join(" ") || `Line ${it.line_no}`;
const namesOf = (bad: any[]) => bad.length ? bad.map(lineName).join(", ") : null;

// One entry per unit, comma separated. Deliberately NOT a row per unit: a qty-5
// line stays one row and carries "S1,S2,S3,S4,S5". Shared by the validator, the
// item read and the quote, so the three cannot disagree about what counts.
function serialList(v: unknown): string[] {
  return String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// A line downgraded to Fair or Broken must carry a client-facing reason --
// it prints on the quote and is what justifies the low offer.
function unreasonedNames(items: any[]): string | null {
  return namesOf(items.filter((it) =>
    REASON_CONDITIONS.includes(String(it.condition || "")) && !String(it.client_notes || "").trim()));
}

// Every unit needs a serial. "NO SERIAL" is a legitimate entry -- plenty of kit
// has no visible one -- so this counts entries, it does not judge them.
function unserialledNames(items: any[]): string | null {
  return namesOf(items.filter((it) => serialList(it.serials).length !== (Number(it.quantity) || 1)));
}

// You cannot price a machine you have no specs for.
function unspeccedNames(items: any[]): string | null {
  return namesOf(items.filter((it) =>
    SPECS_FOR[it.item_type]?.length &&
    SPECS_REQUIRED.some((f) => !String(it[f] ?? "").trim())));
}

// The one gate both submit_pricing and accept_quote run. Checked twice on
// purpose: the quote stays editable in between, so a field can be cleared after
// it first passed. Reports every problem at once rather than one per round trip.
function itemGaps(items: any[]): string | null {
  const parts: string[] = [];
  const reasons = unreasonedNames(items);
  const serials = unserialledNames(items);
  const specs = unspeccedNames(items);
  if (reasons) parts.push(`marked Fair or Broken and need a reason: ${reasons}`);
  if (specs) parts.push(`missing CPU, RAM or storage: ${specs}`);
  if (serials) parts.push(`need one serial per unit (use "No visible serial" where there isn't one): ${serials}`);
  if (!parts.length) return null;
  return `These lines aren't ready — ${parts.join(" · ")}`;
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
        const row = {
          company: str(body.company, 160, "Company name", true),
          acronym: String(body.acronym ?? "").trim().toUpperCase(),
          contact: str(body.contact, 120, "Contact"),
          contact_email: email(body.contact_email, "Email"),
          contact_phone: str(body.contact_phone, 40, "Phone"),
          notes: str(body.notes, 2000, "Notes"),
        };
        if (!/^[A-Z0-9]{2,6}$/.test(row.acronym)) {
          throw new Invalid("Acronym must be 2-6 letters or digits (it leads every SKU).");
        }

        if (action === "create_client") {
          const { data, error } = await supabase.from("b2b_clients").insert(row).select("id").single();
          if (error) {
            const dupe = String(error.message).toLowerCase().includes("duplicate");
            return jsonResponse({ success: false, error: dupe ? "That company name or acronym is already taken." : error.message }, dupe ? 409 : 500);
          }
          await broadcastChange("b2b", null);
          return jsonResponse({ success: true, id: data.id });
        }

        const id = str(body.id, 64, "Client id", true)!;
        // The acronym is baked into every SKU already printed on a label, so it
        // can only change while the client has no deal past pricing.
        const { data: locked } = await supabase.from("b2b_deals")
          .select("id").eq("client_id", id)
          .in("stage", ["quote", "listing_location", "listing", "completed"]).limit(1);
        const { data: current } = await supabase.from("b2b_clients").select("acronym").eq("id", id).maybeSingle();
        if (!current) return jsonResponse({ success: false, error: "That client no longer exists." }, 404);
        if (locked?.length && current.acronym !== row.acronym) {
          return jsonResponse({ success: false, error: "This client already has quoted deals — the acronym is locked into their SKUs." }, 409);
        }
        const { error } = await supabase.from("b2b_clients").update(row).eq("id", id);
        if (error) {
          const dupe = String(error.message).toLowerCase().includes("duplicate");
          return jsonResponse({ success: false, error: dupe ? "That company name or acronym is already taken." : error.message }, dupe ? 409 : 500);
        }
        await broadcastChange("b2b", null);
        return jsonResponse({ success: true });
      }

      if (action === "delete_client") {
        const id = str(body.id, 64, "Client id", true)!;
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
        const clientId = str(body.client_id, 64, "Client", true)!;
        const { data: client } = await supabase.from("b2b_clients")
          .select("id, acronym").eq("id", clientId).maybeSingle();
        if (!client) return jsonResponse({ success: false, error: "That client no longer exists." }, 404);

        // Per-client counter. The unique index is the real guard; on a race we
        // recompute and retry, which is plenty for this volume.
        for (let attempt = 0; attempt < 3; attempt++) {
          const { data: last } = await supabase.from("b2b_deals")
            .select("deal_no").eq("client_id", clientId)
            .order("deal_no", { ascending: false }).limit(1).maybeSingle();
          const dealNo = (last?.deal_no || 0) + 1;
          const { data, error } = await supabase.from("b2b_deals").insert({
            client_id: clientId,
            deal_no: dealNo,
            stage: "pickup",
            pickup_desc: str(body.pickup_desc, 2000, "Pickup description"),
            created_by: str(body.created_by, 120, "Created by") || "Unknown",
          }).select("id").single();
          if (!error) {
            await broadcastChange("b2b", null);
            return jsonResponse({ success: true, id: data.id, deal_no: dealNo, ref: `${client.acronym}-${pad(dealNo, 3)}` });
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
        // Either the client signed, or someone said in writing why they didn't.
        // Never silently neither -- that is the whole value of the signature, and
        // it is the one part of this a client-side role check cannot provide.
        // Enforced on the transition rather than as a CHECK on the table, because
        // deals predating 0022 have neither and must not be rewritten.
        if (!deal.signature_path && !deal.signature_skipped_by) {
          return jsonResponse({
            success: false,
            error: "This pickup needs the client's signature — or a recorded reason for going without one.",
          }, 409);
        }
        const { error } = await supabase.from("b2b_deals").update({
          stage: "pricing_location",
          pickup_desc: str(body.pickup_desc, 2000, "Pickup description"),
          signed_by: str(body.signed_by, 120, "The client's name", true),
          signed_at: new Date().toISOString(),
          pickup_date: isoDate(body.pickup_date, "Pickup date", true),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", null);
        return jsonResponse({ success: true });
      }

      // ========================================================== signature
      // Captured on a staff member's phone, which scanned the QR on the pickup
      // screen and is therefore a signed-in session like any other -- there is
      // no public route here and no anonymous write path.
      //
      // Stored in a PRIVATE bucket, so nothing hands back a URL: the path goes
      // on the deal and `signature=<id>` below streams the bytes back through
      // this function.
      if (action === "capture_signature") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pickup") {
          return jsonResponse({ success: false, error: "This pickup has already been signed off." }, 409);
        }

        // A data URI from a canvas. Refused rather than coerced if it is not a
        // PNG: the bucket only accepts image/png, and a mismatch there fails
        // late and unhelpfully.
        const raw = String(body.image || "");
        const m = raw.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return jsonResponse({ success: false, error: "That doesn't look like a signature image." }, 400);
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
        } catch (_) {
          return jsonResponse({ success: false, error: "The signature image was malformed." }, 400);
        }
        // The bucket caps at 2MB; catching it here gives a sentence instead of a
        // storage error. A real signature is tens of kilobytes.
        if (!bytes.length || bytes.length > 2_000_000) {
          return jsonResponse({ success: false, error: "The signature image is the wrong size." }, 400);
        }

        // Timestamped rather than fixed at "<deal>.png": re-signing keeps the
        // earlier attempt in the bucket instead of overwriting evidence.
        const path = `${deal.id}/${Date.now()}.png`;
        const up = await supabase.storage.from("b2b-signatures")
          .upload(path, bytes, { contentType: "image/png", upsert: false });
        if (up.error) return jsonResponse({ success: false, error: up.error.message }, 500);

        const { error } = await supabase.from("b2b_deals").update({
          signature_path: path,
          signature_at: new Date().toISOString(),
          signature_by: str(body.user, 120, "User"),
          // Signing clears an earlier skip: the deal is no longer unsigned, and
          // leaving the bypass on the row would misreport it forever.
          signature_skipped_by: null,
          signature_skipped_reason: null,
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        // The deal id is what lets the desktop that is showing the QR notice.
        await broadcastChange("b2b", null, { deal: deal.id, by: str(body.user, 80, "User") });
        return jsonResponse({ success: true, signature_at: new Date().toISOString() });
      }

      // Sign off without a signature. Corp only, and the reason is mandatory --
      // a skip with no reason is indistinguishable from an oversight, which is
      // exactly the thing a signature exists to rule out.
      if (action === "skip_signature") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pickup") {
          return jsonResponse({ success: false, error: "This pickup has already been signed off." }, 409);
        }
        const role = String(body.role || "").toLowerCase().trim();
        if (!ACCEPT_ROLES.includes(role)) {
          return jsonResponse({ success: false, error: "Only a CEO, TOM or District Manager can sign off without a signature." }, 403);
        }
        const { error } = await supabase.from("b2b_deals").update({
          signature_skipped_by: str(body.user, 120, "User") || "Unknown",
          signature_skipped_reason: str(body.reason, 1000, "A reason for skipping the signature", true),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", null, { deal: deal.id, by: str(body.user, 80, "User") });
        return jsonResponse({ success: true });
      }

      if (action === "assign_pricing") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pricing_location") return jsonResponse({ success: false, error: "This deal isn't waiting for a pricing location." }, 409);
        const store = oneOf(String(body.pricing_store ?? "").toUpperCase(), PRICING_LOCATIONS, "Pricing location")!;
        const { error } = await supabase.from("b2b_deals").update({
          stage: "pricing",
          pricing_store: store,
          delivered_by: str(body.delivered_by, 120, "Delivered by"),
          received_by: str(body.received_by, 120, "Received by"),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", store);
        return jsonResponse({ success: true });
      }

      // ============================================================== items
      // Editable through pricing, review AND quote — see OPEN_STAGES. A quote
      // stays open while the client negotiates, right up until someone accepts.

      if (action === "add_item" || action === "update_item" || action === "delete_item") {
        const itemId = String(body.id || "");
        let deal: any;
        if (action === "add_item") {
          deal = await getDeal(supabase, String(body.deal_id || ""));
        } else {
          const { data: it } = await supabase.from("b2b_deal_items").select("deal_id").eq("id", itemId).maybeSingle();
          if (!it) return jsonResponse({ success: false, error: "Line item not found." }, 404);
          deal = await getDeal(supabase, it.deal_id);
        }
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (!OPEN_STAGES.includes(deal.stage)) {
          return jsonResponse({ success: false, error: "Line items can only be changed while pricing or quoting." }, 409);
        }

        if (action === "delete_item") {
          const { error } = await supabase.from("b2b_deal_items").delete().eq("id", itemId);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
          await broadcastChange("b2b", dealStore(deal), { deal: deal.id, by: str(body.user, 80, "User") });
          return jsonResponse({ success: true });
        }

        const itemType = oneOf(String(body.item_type ?? "other"), ITEM_TYPES, "Item type")!;
        const disposition = oneOf(String(body.disposition ?? "purchase"), DISPOSITIONS, "Disposition")!;
        const wipeRequired = body.wipe_required === true;

        // Specs are nulled for any field this type does not carry, so switching
        // a laptop to "other" can't leave a stale CPU behind. The table CHECKs
        // the same thing; this is what stops it ever getting that far.
        const carries = SPECS_FOR[itemType] || [];
        const specs: Record<string, string | null> = {};
        for (const f of ["cpu", "ram", "storage", "gpu", "battery_health"]) {
          specs[f] = carries.includes(f) ? str(body[f], 60, f.toUpperCase()) : null;
        }

        const fields = {
          make: str(body.make, 120, "Brand"),
          model: str(body.model, 200, "Model"),
          condition: str(body.condition, 40, "Condition"),
          staff_notes: str(body.staff_notes, 1000, "Staff notes"),
          client_notes: str(body.client_notes, 1000, "Client notes"),
          quantity: count(body.quantity, 1, 100000, "Quantity", 1),
          item_type: itemType,
          ...specs,
          serials: str(body.serials, 4000, "Serial numbers"),
          disposition,
          // Only a purchase carries money to the client; recycle has no resale
          // value to us either. Mirrors the two disposition CHECKs exactly.
          value: disposition === "recycle" ? 0 : money(body.value, "Unit value"),
          offer: disposition === "purchase" ? money(body.offer, "Unit offer") : 0,
          // Ours, per unit, and NOT conditional on disposition: a pallet of scrap
          // still costs money to move. It never reaches the client -- it reduces
          // what the deal is worth to us, not what we pay them.
          shipping_cost: money(body.shipping_cost, "Shipping cost"),
          wipe_required: wipeRequired,
          // Snapshotted per line rather than read live at render time: changing
          // the global fee must not silently reprice a quote already sent. Kept
          // if the line already had one, so an edit to an unrelated field can't
          // move the price a client has been shown.
          wipe_fee: wipeRequired
            ? (Number(body.keep_wipe_fee) > 0 ? money(body.keep_wipe_fee, "Wipe fee") : await wipeFeeNow(supabase))
            : 0,
        };

        if (action === "update_item") {
          const { error } = await supabase.from("b2b_deal_items").update(fields).eq("id", itemId);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
          await broadcastChange("b2b", dealStore(deal), { deal: deal.id, by: str(body.user, 80, "User") });
          return jsonResponse({ success: true });
        }

        // add_item — the SKU is assigned here so a label can be printed the
        // moment the line exists. Line numbers are never reused, so deleting
        // and re-adding leaves a gap and mints a fresh SKU; nothing is frozen
        // until the quote is accepted.
        const { data: last } = await supabase.from("b2b_deal_items")
          .select("line_no").eq("deal_id", deal.id)
          .order("line_no", { ascending: false }).limit(1).maybeSingle();
        const lineNo = (last?.line_no || 0) + 1;
        // Its own query: after a reorder the highest sort_order is not on the
        // highest line_no. Without this the row takes the column default of 0
        // and sorts BEFORE everything -- it would look appended, then jump to the
        // top of the sheet the next time the deal was opened.
        const { data: lastSort } = await supabase.from("b2b_deal_items")
          .select("sort_order").eq("deal_id", deal.id)
          .order("sort_order", { ascending: false }).limit(1).maybeSingle();
        const sortOrder = (Number(lastSort?.sort_order) || 0) + 10;
        const { data, error } = await supabase.from("b2b_deal_items").insert({
          ...fields,
          deal_id: deal.id,
          line_no: lineNo,
          sort_order: sortOrder,
          sku: skuFor(deal.client?.acronym || "B2B", deal.deal_no, lineNo),
        }).select("id, line_no, sku, sort_order").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal), { deal: deal.id, by: str(body.user, 80, "User") });
        return jsonResponse({ success: true, id: data.id, line_no: data.line_no, sku: data.sku, sort_order: data.sort_order });
      }

      // Move a deal to another store mid-flight.
      //
      // Two different moves share this action because they are the same act at
      // different points: before the client accepts, the pricing store is who
      // holds the goods; after, the listing store is. Which one is editable is
      // decided by the stage, not by the caller -- a payload asking to change
      // the pricing store of a deal that is already listing is refused rather
      // than obeyed, because the goods are not there any more.
      //
      // Corp only, same roles that approve a quote: this decides which building
      // physical stock sits in.
      if (action === "transfer_location") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        const role = String(body.role || "").toLowerCase().trim();
        if (!ACCEPT_ROLES.includes(role)) {
          return jsonResponse({ success: false, error: "Only a CEO, TOM or District Manager can move a deal between stores." }, 403);
        }

        // pricing while it is being priced or quoted; listing once it is there.
        const kind = OPEN_STAGES.includes(deal.stage) ? "pricing"
          : (deal.stage === "listing_location" || deal.stage === "listing") ? "listing"
          : null;
        if (!kind) {
          return jsonResponse({
            success: false,
            error: "A deal can only be moved while it is being priced, quoted or listed.",
          }, 409);
        }

        // The listing store must be a real store; pricing may also sit at CORP.
        const to = oneOf(String(body.to_store ?? "").toUpperCase(),
          kind === "pricing" ? PRICING_LOCATIONS : STORES,
          "Store")!;
        const from = kind === "pricing" ? deal.pricing_store : deal.listing_store;
        if (from === to) {
          return jsonResponse({ success: false, error: `This deal is already at ${to}.` }, 409);
        }

        const patch: Record<string, unknown> = kind === "pricing"
          ? { pricing_store: to }
          : { listing_store: to };
        // Moving a CORP-priced deal to a store before acceptance also settles
        // where it will be listed, which is the whole reason it was going to
        // stop at listing_location. Leaving that stale would route it to a
        // store it is no longer at.
        if (kind === "pricing" && deal.stage !== "quote" && deal.listing_store) {
          patch.listing_store = to === "CORP" ? null : to;
        }
        const { error } = await supabase.from("b2b_deals").update(patch).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);

        // Logged after the move, and a logging failure does not undo it: the
        // goods have physically moved either way, and a missing audit line is
        // better than a deal whose record disagrees with the building.
        await supabase.from("b2b_deal_transfers").insert({
          deal_id: deal.id, kind, from_store: from, to_store: to,
          moved_by: str(body.user, 120, "User"),
          note: str(body.note, 1000, "Note"),
        });
        await broadcastChange("b2b", to, { deal: deal.id, by: str(body.user, 80, "User") });
        return jsonResponse({ success: true, kind, from_store: from, to_store: to });
      }

      // Rewrite the display order of a deal's lines.
      //
      // Takes the full id list rather than "move X above Y": the client already
      // knows the order it is showing, and sending it whole means a reorder can
      // never half-apply and leave the sheet in a state nobody chose.
      //
      // Only ids belonging to THIS deal are written -- an id from somewhere else
      // in the payload is ignored rather than trusted, and the count check
      // afterwards catches a stale client that has lines we don't.
      if (action === "reorder_items") {
        const deal = await getDeal(supabase, String(body.deal_id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (!OPEN_STAGES.includes(deal.stage)) {
          return jsonResponse({ success: false, error: "Line items can only be reordered while pricing or quoting." }, 409);
        }
        const order = Array.isArray(body.order) ? body.order.map((v: unknown) => String(v || "")) : [];
        if (!order.length) return jsonResponse({ success: false, error: "No order was sent." }, 400);
        if (order.length > 5000) return jsonResponse({ success: false, error: "That is too many lines to reorder." }, 400);

        const { data: mine } = await supabase.from("b2b_deal_items")
          .select("id").eq("deal_id", deal.id).limit(5000);
        const ours = new Set((mine || []).map((r: any) => r.id));
        const seen = new Set<string>();
        const clean = order.filter((id) => ours.has(id) && !seen.has(id) && seen.add(id));
        if (clean.length !== ours.size) {
          return jsonResponse({
            success: false,
            error: "That list is out of date — reopen the deal and try again.",
          }, 409);
        }
        for (let i = 0; i < clean.length; i++) {
          const { error } = await supabase.from("b2b_deal_items")
            .update({ sort_order: (i + 1) * 10 }).eq("id", clean[i]).eq("deal_id", deal.id);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
        }
        await broadcastChange("b2b", dealStore(deal), { deal: deal.id, by: str(body.user, 80, "User") });
        return jsonResponse({ success: true, ordered: clean.length });
      }

      // ============================================================== quoting

      if (action === "submit_pricing") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "pricing") return jsonResponse({ success: false, error: "This deal isn't in pricing." }, 409);
        const { data: items } = await supabase.from("b2b_deal_items")
          .select("id, line_no, sku, make, model, condition, client_notes, quantity, serials, item_type, cpu, ram, storage")
          .eq("deal_id", deal.id).order("line_no", { ascending: true });
        if (!items?.length) return jsonResponse({ success: false, error: "Add at least one line item before submitting." }, 400);

        const bad = itemGaps(items);
        if (bad) return jsonResponse({ success: false, error: bad }, 400);

        // Backfill for any line created before SKUs were assigned on insert.
        const missing = items.filter((it: any) => !it.sku);
        for (const it of missing) {
          const { error } = await supabase.from("b2b_deal_items")
            .update({ sku: skuFor(deal.client?.acronym || "B2B", deal.deal_no, it.line_no) }).eq("id", it.id);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
        }

        const { error } = await supabase.from("b2b_deals").update({
          // `review`, not `quote`: pricing being finished means it is waiting on
          // an approver, and nothing has gone to the client yet. Sending is what
          // makes it a quote.
          stage: "review",
          priced_by: str(body.priced_by, 120, "Priced by"),
          // Clearing it here means a deal sent back for changes and re-submitted
          // doesn't keep showing the old note as if it were still outstanding.
          sendback_note: null, sendback_by: null, sendback_at: null,
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        // This is the moment the quote becomes someone else's problem, so it is
        // where the approver gets told. Fire and forget: the submit has already
        // succeeded and a mail failure must not undo it.
        await notifyQuoteReady(deal.id);
        return jsonResponse({ success: true });
      }

      // The quote goes out from the quoter's own mailbox via a mailto draft, so
      // the client's reply reaches the person who priced it. This records that
      // it went out, for the stage clock and the Overview.
      //
      // Sending from `review` IS the approval -- there is no separate approve
      // button, because approving a quote and not sending it would leave the
      // deal in exactly the state it was already in. So the same role gate as
      // accepting applies on that edge. Re-sending an already-sent quote is not
      // an approval and stays open to whoever has the deal in front of them.
      if (action === "send_quote") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "review" && deal.stage !== "quote") {
          return jsonResponse({ success: false, error: "Only a deal awaiting approval or already quoted can be sent." }, 409);
        }
        if (deal.stage === "review") {
          const role = String(body.role || "").toLowerCase().trim();
          if (!ACCEPT_ROLES.includes(role)) {
            return jsonResponse({ success: false, error: "Only a CEO, TOM or District Manager can send a quote to the client." }, 403);
          }
        }
        const { error } = await supabase.from("b2b_deals").update({
          stage: "quote",
          quote_sent_at: new Date().toISOString(),
          quote_send_count: Math.min(1000, (deal.quote_send_count || 0) + 1),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true, to: str(body.to, 200, "Recipient") });
      }

      // The hinge: offers freeze into cost, SKUs freeze, and the deal routes on.
      if (action === "accept_quote") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        // `quote` specifically, not `review`: a client cannot accept a quote
        // they were never sent. The UI has always hidden Accept on an unsent
        // quote; now the server agrees with it rather than trusting it.
        if (deal.stage !== "quote") {
          return jsonResponse({ success: false, error: "This quote hasn't been sent to the client yet." }, 409);
        }
        const role = String(body.role || "").toLowerCase().trim();
        if (!ACCEPT_ROLES.includes(role)) {
          return jsonResponse({ success: false, error: "Only a CEO, TOM or District Manager can accept a quote." }, 403);
        }

        const { data: items } = await supabase.from("b2b_deal_items")
          .select("id, line_no, sku, offer, make, model, condition, client_notes, quantity, serials, item_type, cpu, ram, storage")
          .eq("deal_id", deal.id).order("line_no", { ascending: true });
        if (!items?.length) return jsonResponse({ success: false, error: "This quote has no line items." }, 400);

        // Same gate as submit_pricing: the quote stays editable right up to
        // here, so a field could have been cleared after it was first checked.
        const bad = itemGaps(items);
        if (bad) return jsonResponse({ success: false, error: bad }, 400);

        const acronym = deal.client?.acronym || "B2B";
        for (const it of items) {
          const patch: Record<string, unknown> = { cost: it.offer };
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
          accepted_by: str(body.accepted_by, 120, "Accepted by"),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", toCorp ? null : deal.pricing_store);
        return jsonResponse({ success: true, next_stage: toCorp ? "listing_location" : "listing" });
      }

      if (action === "assign_listing") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "listing_location") return jsonResponse({ success: false, error: "This deal isn't waiting for a listing location." }, 409);
        const store = oneOf(String(body.listing_store ?? "").toUpperCase(), STORES, "Listing store")!;
        const { error } = await supabase.from("b2b_deals").update({
          stage: "listing", listing_store: store,
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", store);
        return jsonResponse({ success: true });
      }

      // ============================================================== listing

      // list_unit    { id | (deal_id, sku), shopify_barcode }  one unit goes live
      // unlist_unit  { id, listing_id? }                       undo the last one
      // recycle_units{ id, units }                             pull bad units out
      // mark_wiped   { id, units }                             certify N wiped
      //
      // There is deliberately NO path that marks a unit listed without a Shopify
      // barcode. Every listed unit is one live Shopify listing, so the barcode is
      // what makes the claim checkable; a bare counter was only ever an
      // assertion. listed_qty is now derived by trigger from these rows.
      if (action === "list_unit" || action === "unlist_unit" ||
          action === "recycle_units" || action === "mark_wiped") {
        let item: any;
        if (action === "list_unit" && !body.id) {
          const sku = String(body.sku || "").trim().toUpperCase();
          if (!sku) throw new Invalid("No SKU scanned.");
          if (sku.length > 40) throw new Invalid("That doesn't look like one of our SKUs.");
          const { data } = await supabase.from("b2b_deal_items")
            .select(ITEM_COLS).eq("deal_id", String(body.deal_id || "")).eq("sku", sku).maybeSingle();
          if (!data) return jsonResponse({ success: false, error: `${sku} isn't a line on this deal.` }, 404);
          item = data;
        } else {
          const { data } = await supabase.from("b2b_deal_items")
            .select(ITEM_COLS).eq("id", String(body.id || "")).maybeSingle();
          if (!data) return jsonResponse({ success: false, error: "Line item not found." }, 404);
          item = data;
        }

        const deal = await getDeal(supabase, item.deal_id);
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "listing") return jsonResponse({ success: false, error: "Listing progress can only change while the deal is in listing." }, 409);

        const qty = item.quantity;

        if (action === "recycle_units") {
          const units = count(body.units, 1, 100000, "Units", 1);
          const room = qty - item.listed_qty - item.recycled_qty;
          if (room <= 0) return jsonResponse({ success: false, error: "Every unit on this line is already accounted for." }, 409);
          const { error } = await supabase.from("b2b_deal_items")
            .update({ recycled_qty: item.recycled_qty + Math.min(units, room) }).eq("id", item.id);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);

        } else if (action === "mark_wiped") {
          if (!item.wipe_required) {
            return jsonResponse({ success: false, error: "This line wasn't quoted for a certified wipe." }, 409);
          }
          // Certifying a wipe is a claim we charged the client for. Same corp
          // roles that approve and accept a quote; the store still lists the
          // units, it just doesn't get to say the wipe happened.
          const role = String(body.role || "").toLowerCase().trim();
          if (!ACCEPT_ROLES.includes(role)) {
            return jsonResponse({ success: false, error: "Only a CEO, TOM or District Manager can certify a data wipe." }, 403);
          }
          const units = count(body.units, 1, 100000, "Units", 1);
          const room = qty - item.wiped_qty;
          if (room <= 0) return jsonResponse({ success: false, error: "Every unit on this line is already certified wiped." }, 409);
          const { error } = await supabase.from("b2b_deal_items")
            .update({ wiped_qty: item.wiped_qty + Math.min(units, room) }).eq("id", item.id);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);

        } else if (action === "list_unit") {
          if (item.disposition === "recycle") {
            return jsonResponse({ success: false, error: "A recycle line has nothing to list — recycle it out instead." }, 409);
          }
          const code = barcode8(body.shopify_barcode);
          if (item.listed_qty + item.recycled_qty >= qty) {
            return jsonResponse({ success: false, error: `${item.sku || "This line"} is already fully accounted for (${item.listed_qty}/${qty}).` }, 409);
          }
          // We charged the client for a certified wipe on this line, so a unit
          // cannot go up for sale until one has actually been done. You may list
          // exactly as many as have been certified, no more.
          if (item.wipe_required && item.listed_qty >= item.wiped_qty) {
            return jsonResponse({
              success: false,
              error: `${item.sku || "This line"} needs a certified data wipe first — ${item.wiped_qty} of ${qty} wiped so far.`,
            }, 409);
          }
          const { error } = await supabase.from("b2b_item_listings").insert({
            item_id: item.id, deal_id: item.deal_id, shopify_barcode: code,
            listed_by: str(body.user, 80, "User"),
          });
          if (error) {
            // 23505 is unique_violation. The barcode is unique system-wide, so
            // this is a real signal worth spelling out: the same Shopify listing
            // cannot be two of our units.
            if (error.code === "23505") {
              return jsonResponse({ success: false, error: `Barcode ${code} is already recorded against another unit.` }, 409);
            }
            // 23514 is check_violation -- the listed+recycled<=quantity backstop
            // firing means the capacity check above raced with another lister.
            if (error.code === "23514") {
              return jsonResponse({ success: false, error: "Someone else just listed the last unit on that line." }, 409);
            }
            return jsonResponse({ success: false, error: error.message }, 500);
          }

        } else {
          // Undo: drop a specific listing if one was named, otherwise the most
          // recent -- which is what "I just scanned that wrong" means.
          let target = str(body.listing_id, 40, "Listing");
          if (!target) {
            const { data: last } = await supabase.from("b2b_item_listings")
              .select("id").eq("item_id", item.id)
              .order("listed_at", { ascending: false }).limit(1).maybeSingle();
            if (!last) return jsonResponse({ success: false, error: "That line has no listed units to undo." }, 409);
            target = last.id;
          }
          const { error } = await supabase.from("b2b_item_listings")
            .delete().eq("id", target).eq("item_id", item.id);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
        }

        // listed_qty is trigger-maintained, so the authoritative counts have to
        // be read back rather than computed here. One row for the line, one
        // aggregate for the deal -- the latter tells the client whether that was
        // the last outstanding unit so it can celebrate without another trip.
        const [{ data: fresh }, { data: roll }] = await Promise.all([
          supabase.from("b2b_deal_items").select("listed_qty,recycled_qty,wiped_qty").eq("id", item.id).maybeSingle(),
          supabase.from("b2b_deal_list").select("outstanding_units").eq("id", deal.id).maybeSingle(),
        ]);

        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({
          success: true,
          item_id: item.id, sku: item.sku, quantity: qty,
          listed_qty: fresh?.listed_qty ?? item.listed_qty,
          recycled_qty: fresh?.recycled_qty ?? item.recycled_qty,
          wiped_qty: fresh?.wiped_qty ?? item.wiped_qty,
          listings: await itemListings(supabase, item.id),
          all_done: (roll?.outstanding_units ?? 1) === 0,
        });
      }

      if (action === "complete") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "listing") return jsonResponse({ success: false, error: "Only a deal in listing can be completed." }, 409);
        const { data: roll } = await supabase.from("b2b_deal_list")
          .select("outstanding_units").eq("id", deal.id).maybeSingle();
        const outstanding = roll?.outstanding_units ?? 0;
        if (outstanding > 0) {
          return jsonResponse({ success: false, error: `${outstanding} unit${outstanding === 1 ? "" : "s"} still need listing or recycling.` }, 409);
        }
        const { error } = await supabase.from("b2b_deals").update({ stage: "completed" }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true });
      }

      // Bounce a quote back to whoever priced it, with a note saying why.
      //
      // The only backwards edge in the pipeline that isn't decline/reopen. It is
      // safe against the state-machine CHECKs because quote -> pricing only
      // lowers the rank, and b2b_deals_pricing_located just requires a
      // pricing_store at rank >= 3, which this deal already has.
      //
      // Same role gate as accepting: deciding a quote isn't good enough is the
      // same authority as deciding it is.
      if (action === "request_changes") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        // From review (the normal case) or from quote -- a client coming back
        // with "can you re-look at the laptops" needs the same road home, and
        // that was possible before the stage split too.
        if (deal.stage !== "review" && deal.stage !== "quote") {
          return jsonResponse({ success: false, error: "Only a quote awaiting approval or out with the client can be sent back." }, 409);
        }
        const role = String(body.role || "").toLowerCase().trim();
        if (!ACCEPT_ROLES.includes(role)) {
          return jsonResponse({ success: false, error: "Only a CEO, TOM or District Manager can send a quote back." }, 403);
        }
        const { error } = await supabase.from("b2b_deals").update({
          stage: "pricing",
          // Cleared because it is no longer true -- someone has to price it
          // again, and the queue reads this to decide the stage is unowned.
          priced_by: null,
          // quote_send_count is deliberately NOT reset any more. It had to be,
          // while it was doubling as the awaiting-approval flag -- otherwise a
          // re-submitted quote came back claiming the client already had the
          // corrected numbers. The stage carries that now, so the counter is
          // back to being plain history: how many times this deal has actually
          // been emailed to the client, which zeroing it would destroy.
          sendback_note: str(body.note, 2000, "A note saying what needs changing", true),
          sendback_by: str(body.sent_back_by, 120, "Sent back by"),
          sendback_at: new Date().toISOString(),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true });
      }

      // The deal died. Reachable any time before listing -- once a quote is
      // accepted the goods are already ours, so there is nothing left to
      // decline. A reason is mandatory: a dead deal with no explanation is
      // worse than no record at all.
      if (action === "decline") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        // 7 is `listing` under the post-0018 numbering -- the same boundary this
        // has always drawn, moved up one because `review` was inserted below it.
        if (STAGE_RANK[deal.stage] >= 7) {
          return jsonResponse({ success: false, error: "This deal was already accepted — the goods are ours, so it can't be declined." }, 409);
        }
        if (deal.stage === "declined") {
          return jsonResponse({ success: false, error: "This deal is already marked declined." }, 409);
        }
        const { error } = await supabase.from("b2b_deals").update({
          stage: "declined",
          declined_at: new Date().toISOString(),
          declined_by: str(body.declined_by, 120, "Declined by"),
          declined_reason: str(body.reason, 1000, "Reason", true),
          declined_category: oneOf(body.category, DECLINE_CATEGORIES, "Category", false),
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true });
      }

      // A declined deal that turns out to be alive after all goes back to where
      // it died, rather than starting over.
      if (action === "reopen") {
        const deal = await getDeal(supabase, String(body.id || ""));
        if (!deal) return jsonResponse({ success: false, error: "Deal not found." }, 404);
        if (deal.stage !== "declined") return jsonResponse({ success: false, error: "Only a declined deal can be reopened." }, 409);
        // Resume at the furthest stage its own data can satisfy. Checking
        // listing_store as well as accepted_at matters: a CORP deal declined
        // at listing_location has been accepted but has no listing store yet,
        // and sending it straight to listing would trip the state-machine
        // constraint.
        const stage = (deal.accepted_at && deal.listing_store) ? "listing"
          : deal.accepted_at ? "listing_location"
          // Priced, so it is at least at review. Whether it got as far as the
          // client is the one thing the row itself still records -- this is the
          // last remaining read of quote_send_count as a state, and it is the
          // right one: reopening must put the deal back where it died.
          : deal.priced_by ? ((deal.quote_send_count || 0) > 0 ? "quote" : "review")
          : deal.pricing_store ? "pricing"
          : deal.signed_at ? "pricing_location"
          : "pickup";
        const { error } = await supabase.from("b2b_deals").update({
          stage, declined_at: null, declined_by: null,
          declined_reason: null, declined_category: null,
        }).eq("id", deal.id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        await broadcastChange("b2b", dealStore(deal));
        return jsonResponse({ success: true, stage });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      if (err instanceof Invalid) return jsonResponse({ success: false, error: err.message }, 400);
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---------------------------------------------------------------- GET reads

  try {
    const url = new URL(req.url);

    // ?signature=<deal id> → the signature image itself.
    //
    // The bucket is private, so this is the only way to see one. Streamed rather
    // than redirected to a signed URL: a signed URL is a link that keeps working
    // after it leaves the page, and this is the one asset here where that is
    // worth avoiding.
    const sigFor = url.searchParams.get("signature");
    if (sigFor) {
      const { data: d } = await supabase.from("b2b_deals")
        .select("signature_path").eq("id", sigFor).maybeSingle();
      if (!d?.signature_path) return jsonResponse({ success: false, error: "No signature on that deal." }, 404);
      const dl = await supabase.storage.from("b2b-signatures").download(d.signature_path);
      if (dl.error || !dl.data) return jsonResponse({ success: false, error: "Couldn't read the signature." }, 500);
      return new Response(await dl.data.arrayBuffer(), {
        headers: { ...corsHeaders, "Content-Type": "image/png", "Cache-Control": "private, max-age=60" },
      });
    }

    // ?clients=1 → the directory, with deal counts rolled up in the view
    if (url.searchParams.get("clients")) {
      const { data, error } = await supabase.from("b2b_client_list")
        .select("*").order("company", { ascending: true }).limit(2000);
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      return jsonResponse({ success: true, data: data || [] });
    }

    // ?deal_id=<uuid> → that deal's line items, each with the Shopify listings
    // its units became. Two queries indexed on deal_id rather than a per-item
    // fan-out, then grouped here.
    const dealId = url.searchParams.get("deal_id");
    if (dealId) {
      const [{ data, error }, { data: listings, error: lErr }] = await Promise.all([
        supabase.from("b2b_deal_items")
          .select(ITEM_COLS).eq("deal_id", dealId)
          .order("sort_order", { ascending: true })
          .order("line_no", { ascending: true }).limit(5000),
        supabase.from("b2b_item_listings")
          .select("id,item_id,shopify_barcode,listed_by,listed_at").eq("deal_id", dealId)
          .order("listed_at", { ascending: true }).limit(20000),
      ]);
      if (error) return jsonResponse({ success: false, error: error.message }, 500);
      if (lErr) return jsonResponse({ success: false, error: lErr.message }, 500);

      const byItem: Record<string, any[]> = {};
      for (const l of listings || []) (byItem[l.item_id] ||= []).push(l);

      return jsonResponse({
        success: true,
        data: (data || []).map((it: any) => {
          const done = it.listed_qty + it.recycled_qty;
          return {
            ...it,
            listings: byItem[it.id] || [],
            serial_list: serialList(it.serials),
            qty_value_total: it.disposition === "recycle" ? 0 : it.value * it.quantity,
            qty_offer_total: it.offer * it.quantity,
            qty_wipe_total: it.wipe_required ? it.wipe_fee * it.quantity : 0,
            qty_shipping_total: it.shipping_cost * it.quantity,
            outstanding: Math.max(0, it.quantity - done),
            satisfied: done >= it.quantity,
          };
        }),
      });
    }

    // ?store=ALL|<CODE> → the board.
    // Open deals come back in full because they are the working set and it is
    // bounded by how much work is actually in flight. Finished deals are the
    // unbounded half, so only the recent tail rides along; ?archive=N pages
    // deeper and the response says when it truncated.
    const store = String(url.searchParams.get("store") || "ALL").toUpperCase();
    const oneStore = !!store && store !== "ALL";
    const archiveWanted = Math.min(ARCHIVE_MAX, Math.max(0, intOr(url.searchParams.get("archive"), ARCHIVE_DEFAULT)));
    const scoped = (q: any) => oneStore
      ? q.or(`pricing_store.eq.${store},listing_store.eq.${store}`)
      : q;
    // A board scoped to one store is a store user's board, and they have no
    // business with the client's contact details -- see CONTACT_COLS. Corp asks
    // for ALL and still gets them.
    const cols = oneStore ? SCOPED_DEAL_COLS : DEAL_COLS;

    const openQ = scoped(
      supabase.from("b2b_deal_list").select(cols)
        .not("stage", "in", `(${TERMINAL.join(",")})`)
        .order("created_at", { ascending: false }).limit(2000),
    );
    const archiveQ = scoped(
      supabase.from("b2b_deal_list").select(cols)
        .in("stage", TERMINAL)
        .order("stage_changed_at", { ascending: false }).limit(Math.max(1, archiveWanted)),
    );
    const countQ = scoped(
      supabase.from("b2b_deal_list").select("id", { count: "exact", head: true }).in("stage", TERMINAL),
    );

    const [open, archive, counted, wipeFee] = await Promise.all([openQ, archiveQ, countQ, wipeFeeNow(supabase)]);
    if (open.error) return jsonResponse({ success: false, error: open.error.message }, 500);
    if (archive.error) return jsonResponse({ success: false, error: archive.error.message }, 500);

    const archiveRows = archiveWanted === 0 ? [] : (archive.data || []);
    const archiveTotal = counted.count ?? archiveRows.length;
    return jsonResponse({
      success: true,
      data: [...(open.data || []), ...archiveRows],
      meta: {
        open: (open.data || []).length,
        archive_shown: archiveRows.length,
        archive_total: archiveTotal,
        archive_truncated: archiveTotal > archiveRows.length,
        // So the pricing screen can show what a wipe costs without needing the
        // CEO-only settings endpoint.
        wipe_fee: wipeFee,
      },
    });
  } catch (err: any) {
    if (err instanceof Invalid) return jsonResponse({ success: false, error: err.message }, 400);
    return jsonResponse({ success: false, error: err.message }, 500);
  }
});
