import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Variance Replies. The DM uploads the ≤ -10% variance line items per store
// per period (parsed client-side from their Excel sheet); store managers
// explain each line (gm_note), the DM responds (dm_note), managers reply back
// (mgr_reply). Tables: variance_reply_periods + variance_reply_items.

const NOTE_FIELDS = new Set(["gm_note", "dm_note", "mgr_reply"]);
const MANAGER_REPLY_DAYS = 7; // managers get a week from upload

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

// The DM uploads the ≤-10% line items (this tool) and the team variance report
// (the "Submit Variance Report" tool → variance_entries) at the same time for
// the same store + date range. Pull that matching team-variance entry so it can
// be shown as context above the reply lines. Prefers an exact store+range match
// (both uploaded together); otherwise the store's closest entry within ~3 weeks.
async function getTeamVariance(supabase: any, period: any) {
  const { data: exact } = await supabase.from("variance_entries")
    .select("id, store_pct, date_from, date_to")
    .eq("store", period.store)
    .eq("date_from", period.date_from)
    .eq("date_to", period.date_to)
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();

  let entry = exact;
  if (!entry) {
    const { data: near } = await supabase.from("variance_entries")
      .select("id, store_pct, date_from, date_to")
      .eq("store", period.store)
      .order("date_to", { ascending: false });
    const target = new Date(period.date_to).getTime();
    const WINDOW = 21 * 86400000;
    entry = (near || [])
      .map((e: any) => ({ e, d: Math.abs(new Date(e.date_to).getTime() - target) }))
      .filter((x: any) => x.d <= WINDOW)
      .sort((a: any, b: any) => a.d - b.d)
      .map((x: any) => x.e)[0] || null;
  }
  if (!entry) return null;

  const { data: emps } = await supabase.from("variance_employee_entries")
    .select("employee_name, variance_pct").eq("entry_id", entry.id).order("employee_name");
  return {
    total: entry.store_pct,
    date_from: entry.date_from,
    date_to: entry.date_to,
    exact: !!exact, // false → dates differ from the reply period; show its own range
    employees: (emps || []).map((e: any) => ({ name: e.employee_name, val: e.variance_pct })),
  };
}

// The store's most recent team-variance entry (store total % + per-person %),
// not tied to any reply period. Used for a store that's "in the clear": its
// managers no longer answer line items, they just see this summary.
async function getLatestTeamVariance(supabase: any, store: string) {
  const { data: entry } = await supabase.from("variance_entries")
    .select("id, store_pct, date_from, date_to")
    .eq("store", store)
    .order("date_to", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (!entry) return null;
  const { data: emps } = await supabase.from("variance_employee_entries")
    .select("employee_name, variance_pct").eq("entry_id", entry.id).order("employee_name");
  return {
    total: entry.store_pct,
    date_from: entry.date_from,
    date_to: entry.date_to,
    employees: (emps || []).map((e: any) => ({ name: e.employee_name, val: e.variance_pct })),
  };
}

// Base64 (from the browser's FileReader) → bytes for a Storage upload.
function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const RAW_BUCKET = "variance-reports";

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

      // ---- DM uploads a period: header + all its line items in one call ----
      if (action === "upload_period") {
        const store = String(body.store || "").toUpperCase();
        const dateFrom = String(body.date_from || "");
        const dateTo = String(body.date_to || "");
        const items = Array.isArray(body.items) ? body.items : [];
        if (!store || !dateFrom || !dateTo) {
          return jsonResponse({ success: false, error: "store, date_from and date_to are required" }, 400);
        }
        if (!items.length) {
          return jsonResponse({ success: false, error: "No line items to upload" }, 400);
        }
        const due = new Date();
        due.setDate(due.getDate() + MANAGER_REPLY_DAYS);
        const { data: period, error: pErr } = await supabase.from("variance_reply_periods").insert({
          store,
          date_from: dateFrom,
          date_to: dateTo,
          timeframe: body.timeframe ? String(body.timeframe) : null,
          uploaded_by: body.uploaded_by ? String(body.uploaded_by).trim() : null,
          manager_due_at: due.toISOString(),
        }).select().single();
        if (pErr) return jsonResponse({ success: false, error: pErr.message }, 500);

        const rows = items.map((it: any, i: number) => ({
          period_id: period.id,
          sort_order: i,
          order_number: it.order_number ? String(it.order_number).trim() : null,
          sku: it.sku ? String(it.sku).trim() : null,
          item_title: it.item_title ? String(it.item_title).trim() : null,
          buyer_name: it.buyer_name ? String(it.buyer_name).trim() : null,
          lister_name: it.lister_name ? String(it.lister_name).trim() : null,
          variance_pct: parseNum(it.variance_pct),
          // allow pre-filled notes so the current spreadsheet cycle can be ported
          gm_note: it.gm_note ? String(it.gm_note).trim() : null,
          dm_note: it.dm_note ? String(it.dm_note).trim() : null,
          mgr_reply: it.mgr_reply ? String(it.mgr_reply).trim() : null,
        }));
        const { error: iErr } = await supabase.from("variance_reply_items").insert(rows);
        if (iErr) {
          // don't leave a header without lines
          await supabase.from("variance_reply_periods").delete().eq("id", period.id);
          return jsonResponse({ success: false, error: iErr.message }, 500);
        }

        // Stash the original workbook so managers can download the full report
        // (every line, incl. the ones below the -10% cutoff we didn't import).
        // A storage hiccup shouldn't fail the whole upload — the notes matter
        // more than the download, so we just skip the file on error.
        if (body.raw_file_b64) {
          try {
            const rawName = body.raw_file_name ? String(body.raw_file_name) : "variance-report.xlsx";
            const path = `${period.id}/${rawName}`;
            const bytes = b64ToBytes(String(body.raw_file_b64));
            const ct = rawName.toLowerCase().endsWith(".csv")
              ? "text/csv"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            const { error: upErr } = await supabase.storage.from(RAW_BUCKET)
              .upload(path, bytes, { contentType: ct, upsert: true });
            if (!upErr) {
              await supabase.from("variance_reply_periods")
                .update({ raw_file_name: rawName, raw_file_path: path }).eq("id", period.id);
            }
          } catch (_e) { /* keep the upload; the file is a bonus */ }
        }
        return jsonResponse({ success: true, period_id: period.id, count: rows.length });
      }

      // ---- Save one note cell (manager gm_note / DM dm_note / manager mgr_reply) ----
      if (action === "save_note") {
        const id = String(body.item_id || "");
        const field = String(body.field || "");
        if (!id || !NOTE_FIELDS.has(field)) {
          return jsonResponse({ success: false, error: "Valid item_id and field required" }, 400);
        }
        const text = body.text === null || body.text === undefined ? "" : String(body.text).trim();
        const by = body.by ? String(body.by).trim() : null;
        const now = new Date().toISOString();
        const patch: Record<string, unknown> = {
          [field]: text || null,
          [`${field}_by`]: text ? by : null,
          [`${field}_at`]: text ? now : null,
        };
        // A DM note carries a "needs a manager reply" flag; FYI-only notes
        // (flag off) don't count toward awaiting_reply nudges.
        if (field === "dm_note") {
          patch.dm_reply_requested = text ? !!body.reply_requested : false;
        }
        const { data: item, error } = await supabase.from("variance_reply_items")
          .update(patch).eq("id", id).select("period_id").single();
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        // First DM note on a period starts the manager "review DM notes" cycle.
        if (field === "dm_note" && text) {
          const { data: period } = await supabase.from("variance_reply_periods")
            .select("dm_notes_at").eq("id", item.period_id).maybeSingle();
          if (period && !period.dm_notes_at) {
            await supabase.from("variance_reply_periods")
              .update({ dm_notes_at: now }).eq("id", item.period_id);
          }
        }
        return jsonResponse({ success: true });
      }

      // ---- DM marks a store "in the clear" (or reactivates it) ----
      // A cleared store's managers stop seeing/answering line items and get no
      // dots/popups; they just see their team + store-total variance. The DM
      // flips this back on the moment the store starts slipping again.
      if (action === "set_store_status") {
        const store = String(body.store || "").toUpperCase();
        if (!store) return jsonResponse({ success: false, error: "store is required" }, 400);
        const by = body.by ? String(body.by).trim() : null;
        const { error } = await supabase.from("variance_store_status").upsert({
          store,
          in_the_clear: !!body.in_the_clear,
          updated_by: by,
          updated_at: new Date().toISOString(),
        }, { onConflict: "store" });
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- DM deletes an upload (mistake fix; items cascade) ----
      if (action === "delete_period") {
        const id = String(body.id || "");
        if (!id) return jsonResponse({ success: false, error: "Missing id" }, 400);
        // Clear the stored raw file too so deleted uploads don't orphan blobs.
        const { data: period } = await supabase.from("variance_reply_periods")
          .select("raw_file_path").eq("id", id).maybeSingle();
        if (period?.raw_file_path) {
          try { await supabase.storage.from(RAW_BUCKET).remove([period.raw_file_path]); } catch (_e) { /* best effort */ }
        }
        const { error } = await supabase.from("variance_reply_periods").delete().eq("id", id);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET ----
  const url = new URL(req.url);

  // ?file=<period_id> → a short-lived signed URL to download the raw upload.
  const fileId = url.searchParams.get("file");
  if (fileId) {
    const { data: period, error } = await supabase.from("variance_reply_periods")
      .select("raw_file_path, raw_file_name").eq("id", fileId).maybeSingle();
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
    if (!period || !period.raw_file_path) {
      return jsonResponse({ success: false, error: "No file on this upload" }, 404);
    }
    const { data: signed, error: sErr } = await supabase.storage.from(RAW_BUCKET)
      .createSignedUrl(period.raw_file_path, 300, { download: period.raw_file_name || true });
    if (sErr) return jsonResponse({ success: false, error: sErr.message }, 500);
    return jsonResponse({ success: true, url: signed?.signedUrl, name: period.raw_file_name });
  }

  // ?period_id=… → the period header + every line item
  const periodId = url.searchParams.get("period_id");
  if (periodId) {
    const { data: period, error: pErr } = await supabase.from("variance_reply_periods")
      .select("*").eq("id", periodId).maybeSingle();
    if (pErr) return jsonResponse({ success: false, error: pErr.message }, 500);
    if (!period) return jsonResponse({ success: false, error: "Period not found" }, 404);
    const { data: items, error: iErr } = await supabase.from("variance_reply_items")
      .select("*").eq("period_id", periodId).order("sort_order", { ascending: true });
    if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);
    const teamVariance = await getTeamVariance(supabase, period);
    return jsonResponse({ success: true, period, items: items || [], team_variance: teamVariance });
  }

  // [?stores=A,B] → period list (newest first) with reply-progress counts,
  // which also powers the pulsing dots and reminder popups client-side.
  const storesParam = url.searchParams.get("stores") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  let pq = supabase.from("variance_reply_periods").select("*")
    .order("uploaded_at", { ascending: false }).limit(40);
  if (stores.length) pq = pq.in("store", stores);
  const { data: periods, error: pErr } = await pq;
  if (pErr) return jsonResponse({ success: false, error: pErr.message }, 500);

  const ids = (periods || []).map((p: any) => p.id);
  const counts: Record<string, { items: number; answered: number; awaiting_reply: number; mgr_replied: number }> = {};
  if (ids.length) {
    const { data: items, error: iErr } = await supabase.from("variance_reply_items")
      .select("period_id, gm_note, dm_note, mgr_reply, dm_reply_requested").in("period_id", ids);
    if (iErr) return jsonResponse({ success: false, error: iErr.message }, 500);
    (items || []).forEach((it: any) => {
      const c = (counts[it.period_id] = counts[it.period_id] || { items: 0, answered: 0, awaiting_reply: 0, mgr_replied: 0 });
      c.items++;
      if (it.gm_note) c.answered++;
      // only notes the DM flagged as needing a response nag the manager;
      // FYI-only notes are just for their review
      if (it.dm_note && it.dm_reply_requested && !it.mgr_reply) c.awaiting_reply++;
      // a flagged note the manager HAS answered — a reply for the DM to read
      if (it.dm_note && it.dm_reply_requested && it.mgr_reply) c.mgr_replied++;
    });
  }
  const data = (periods || []).map((p: any) => ({
    ...p,
    ...(counts[p.id] || { items: 0, answered: 0, awaiting_reply: 0, mgr_replied: 0 }),
  }));

  // Per-store "in the clear" status for the requested stores, plus the latest
  // team-variance summary for any store that IS cleared (so its managers can
  // render their summary panel without a second round trip).
  const storeStatus: Record<string, { in_the_clear: boolean; updated_by: string | null; updated_at: string | null }> = {};
  const clearedTeamVariance: Record<string, unknown> = {};
  let sq = supabase.from("variance_store_status").select("*");
  if (stores.length) sq = sq.in("store", stores);
  const { data: statuses } = await sq;
  for (const s of (statuses || [])) {
    storeStatus[s.store] = { in_the_clear: !!s.in_the_clear, updated_by: s.updated_by, updated_at: s.updated_at };
  }
  const clearedStores = Object.keys(storeStatus).filter((s) => storeStatus[s].in_the_clear);
  for (const s of clearedStores) {
    clearedTeamVariance[s] = await getLatestTeamVariance(supabase, s);
  }
  return jsonResponse({ success: true, data, store_status: storeStatus, cleared_team_variance: clearedTeamVariance });
});
