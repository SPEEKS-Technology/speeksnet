import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Buying Margin Review. Phase 1: generate the weekly per-store report straight
// out of kpi_entries (no upload needed) and serve it. Line-item upload and the
// reply cycle land in phase 2 — the tables are already there for them.
//
// See supabase/migrations/0004_buying_margin.sql for the rule and the why.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Dates -----------------------------------------------------------------
// The edge runtime is UTC; every date here is a America/Chicago calendar date.
// See the checklist fn for the timestamptz version of this problem.

function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD
}

// Plain date math on YYYY-MM-DD, anchored at noon UTC so no offset can shift
// the calendar day.
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function dayOfWeek(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 = Sunday
}

// The Sunday that closed the most recently finished week. Cron fires Monday, so
// this lands on yesterday; run it on a Wednesday and you still get that Sunday.
function lastSunday(iso: string): string {
  const dow = dayOfWeek(iso);
  return dow === 0 ? addDays(iso, -7) : addDays(iso, -dow);
}

function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

// --- Math ------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Dollar-weighted margin. Never an average of percentages — that is the whole
// point of aggregating value and cost separately.
function marginPct(value: number, cost: number): number | null {
  if (!value) return null;
  return Math.round(((value - cost) / value) * 1000) / 10;
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

// Realtime "ping" so signed-in clients re-run their check; no table data rides
// on the broadcast. Best-effort — it can never fail a write.
async function broadcastChange(store: string | null) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{
          topic: "speeks-notify",
          event: "changed",
          payload: { tool: "bmargin", store: store ? store.toUpperCase() : null, ts: Date.now() },
        }],
      }),
    });
  } catch (_) { /* best-effort */ }
}

async function getConfig(supabase: any) {
  const { data } = await supabase.from("bm_config").select("*").eq("id", 1).maybeSingle();
  return data || {
    buyer_margin_max: 54, min_buys_2wk: 10, item_margin_max: 50,
    min_dollars_lost: 25, target_margin: 54.5, top_n_items: 10, reply_days: 5,
  };
}

type Row = {
  store: string; employee_name: string; period_end_date: string;
  buying_value: number; buying_cost: number;
  transaction_count: number; transaction_converted: number;
  device_count: number; device_converted: number;
};

// ---------------------------------------------------------------------------
// Generate one store's report for the week ending `weekEnd`.
//
// Re-running is safe and non-destructive: the period and its buyer rows are
// upserted, and uploaded line items (with any manager/DM notes on them) are
// left completely alone. A DM re-running after a late KPI submission must never
// wipe replies that are already written.
// ---------------------------------------------------------------------------
async function generateForStore(supabase: any, store: string, weekEnd: string, by: string | null) {
  const cfg = await getConfig(supabase);
  const priorWeek = addDays(weekEnd, -7);
  const windowFrom = addDays(weekEnd, -13);

  const { data: raw, error } = await supabase
    .from("kpi_entries")
    .select("store, employee_name, period_end_date, buying_value, buying_cost, transaction_count, transaction_converted, device_count, device_converted")
    .eq("period_type", "weekly")
    .eq("store", store)
    .in("period_end_date", [weekEnd, priorWeek]);
  if (error) throw new Error(error.message);

  const rows = (raw || []) as Row[];

  // Group by buyer. Keyed on name within an already store-scoped query, so a
  // buyer who transferred mid-window is evaluated separately at each store —
  // each manager answers only for the buys made on their own floor.
  const byBuyer = new Map<string, Row[]>();
  for (const r of rows) {
    const name = (r.employee_name || "").trim();
    if (!name) continue;
    if (!byBuyer.has(name)) byBuyer.set(name, []);
    byBuyer.get(name)!.push(r);
  }

  // Previous period's buyer rows, for the consecutive-flag escalation counter.
  const { data: priorPeriod } = await supabase.from("bm_periods")
    .select("id, flagged_count").eq("store", store).eq("week_end", priorWeek).maybeSingle();
  const priorFlags = new Map<string, number>();
  if (priorPeriod) {
    const { data: pb } = await supabase.from("bm_buyers")
      .select("buyer_name, flagged, consecutive_flags").eq("period_id", priorPeriod.id);
    for (const b of (pb || [])) {
      if (b.flagged) priorFlags.set(b.buyer_name, num(b.consecutive_flags) || 1);
    }
  }

  let storeValue2 = 0, storeCost2 = 0;
  let weekValue = 0, weekCost = 0, priorValue = 0, priorCost = 0;
  let flagged = 0, incomplete = 0;

  const buyers: any[] = [];

  for (const [name, rs] of byBuyer) {
    const cur = rs.find((r) => r.period_end_date === weekEnd);
    const prev = rs.find((r) => r.period_end_date === priorWeek);

    const v2 = num(cur?.buying_value) + num(prev?.buying_value);
    const c2 = num(cur?.buying_cost) + num(prev?.buying_cost);
    const buys2 = num(cur?.transaction_converted) + num(prev?.transaction_converted);

    storeValue2 += v2; storeCost2 += c2;
    weekValue += num(cur?.buying_value);  weekCost += num(cur?.buying_cost);
    priorValue += num(prev?.buying_value); priorCost += num(prev?.buying_cost);

    const m2 = marginPct(v2, c2);
    const mWeek = cur ? marginPct(num(cur.buying_value), num(cur.buying_cost)) : null;
    const mPrev = prev ? marginPct(num(prev.buying_value), num(prev.buying_cost)) : null;

    const custConv = cur ? pct(num(cur.transaction_converted), num(cur.transaction_count)) : null;
    const custPrior = prev ? pct(num(prev.transaction_converted), num(prev.transaction_count)) : null;
    const devConv = cur ? pct(num(cur.device_converted), num(cur.device_count)) : null;
    const devPrior = prev ? pct(num(prev.device_converted), num(prev.device_count)) : null;

    // Margin up while a conversion metric fell more than 3 points — margin
    // bought by walking deals. Context only; it never triggers a review.
    const guardrail = !!(
      mWeek != null && mPrev != null && mWeek > mPrev &&
      ((custConv != null && custPrior != null && custConv < custPrior - 3) ||
       (devConv != null && devPrior != null && devConv < devPrior - 3))
    );

    // Only weeks the buyer actually bought in count as present; a zero-value
    // row is a scheduled-off week, not a sample.
    const weeksPresent = [cur, prev].filter((r) => r && num(r.buying_value) > 0).length;
    if (weeksPresent === 1) incomplete++;

    let status = "ok";
    let isFlagged = false;
    if (m2 == null) {
      status = "no_data";
    } else if (m2 < num(cfg.buyer_margin_max)) {
      if (buys2 >= num(cfg.min_buys_2wk)) { status = "eligible"; isFlagged = true; }
      else status = "below_min_buys";
    }
    if (isFlagged) flagged++;

    buyers.push({
      store, buyer_name: name,
      margin_2wk: m2, margin_week: mWeek, margin_prior_week: mPrev,
      buys_2wk: buys2, buys_week: num(cur?.transaction_converted),
      buy_value_2wk: Math.round(v2),
      cust_conv: custConv, cust_conv_prior: custPrior,
      device_conv: devConv, device_conv_prior: devPrior,
      guardrail, weeks_present: weeksPresent,
      flagged: isFlagged, status,
      consecutive_flags: isFlagged ? (priorFlags.get(name) || 0) + 1 : 0,
    });
  }

  // Worst margin first, so the manager reads top-down in priority order.
  // Buyers with no margin at all sink to the bottom.
  buyers.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    if (a.margin_2wk == null) return 1;
    if (b.margin_2wk == null) return -1;
    return a.margin_2wk - b.margin_2wk;
  });
  buyers.forEach((b, i) => { b.sort_order = i; });

  const due = addBusinessDays(new Date(), num(cfg.reply_days) || 5);

  const periodRow = {
    store,
    week_end: weekEnd,
    window_from: windowFrom,
    window_to: weekEnd,
    generated_at: new Date().toISOString(),
    generated_by: by || "cron",
    manager_due_at: due.toISOString(),
    store_margin_2wk: marginPct(storeValue2, storeCost2),
    store_margin_week: marginPct(weekValue, weekCost),
    store_margin_prior: marginPct(priorValue, priorCost),
    buy_value_2wk: Math.round(storeValue2),
    buyers_evaluated: buyers.length,
    flagged_count: flagged,
    prior_flagged_count: priorPeriod ? num(priorPeriod.flagged_count) : null,
    incomplete_count: incomplete,
    config: cfg,
  };

  const { data: period, error: pErr } = await supabase
    .from("bm_periods").upsert(periodRow, { onConflict: "store,week_end" }).select().single();
  if (pErr) throw new Error(pErr.message);

  if (buyers.length) {
    const { error: bErr } = await supabase.from("bm_buyers")
      .upsert(buyers.map((b) => ({ ...b, period_id: period.id })), { onConflict: "period_id,buyer_name" });
    if (bErr) throw new Error(bErr.message);
  }

  return { store, period_id: period.id, week_end: weekEnd, evaluated: buyers.length, flagged };
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

      // ---- Generate the weekly report (cron Monday 10:00 Central, or manual) ----
      if (action === "generate_period") {
        const weekEnd = body.week_end ? String(body.week_end) : lastSunday(centralToday());
        const stores = Array.isArray(body.stores) && body.stores.length
          ? body.stores.map((s: string) => String(s).toUpperCase())
          : STORES;
        const by = body.by ? String(body.by).trim() : null;

        const results = [];
        const failures = [];
        for (const store of stores) {
          // One bad store must not abort the other four.
          try { results.push(await generateForStore(supabase, store, weekEnd, by)); }
          catch (e: any) { failures.push({ store, error: e.message }); }
        }
        await broadcastChange(null);
        // success:true even with per-store failures — the call itself worked, and
        // the client throws on success:false, which would swallow `failures` and
        // replace the per-store detail with a generic error.
        return json({ success: true, week_end: weekEnd, results, failures });
      }

      // ---- DM edits the thresholds (no code change needed to re-tune) ----
      if (action === "set_config") {
        const allowed = ["buyer_margin_max", "min_buys_2wk", "item_margin_max",
                         "min_dollars_lost", "target_margin", "top_n_items", "reply_days"];
        const patch: Record<string, unknown> = {};
        for (const k of allowed) {
          if (body[k] !== undefined && body[k] !== null && body[k] !== "") patch[k] = Number(body[k]);
        }
        if (!Object.keys(patch).length) return json({ success: false, error: "Nothing to update" }, 400);
        patch.updated_by = body.by ? String(body.by).trim() : null;
        patch.updated_at = new Date().toISOString();
        const { error } = await supabase.from("bm_config").update(patch).eq("id", 1);
        if (error) return json({ success: false, error: error.message }, 500);
        await broadcastChange(null);
        return json({ success: true });
      }

      // ---- DM marks a store in the clear / brings it back in ----
      if (action === "set_store_status") {
        const store = String(body.store || "").toUpperCase();
        if (!store) return json({ success: false, error: "store is required" }, 400);
        const { error } = await supabase.from("bm_store_status").upsert({
          store,
          in_the_clear: !!body.in_the_clear,
          updated_by: body.by ? String(body.by).trim() : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "store" });
        if (error) return json({ success: false, error: error.message }, 500);
        await broadcastChange(store);
        return json({ success: true });
      }

      // ---- Delete a generated period (buyers + items cascade) ----
      if (action === "delete_period") {
        const id = String(body.id || "");
        if (!id) return json({ success: false, error: "Missing id" }, 400);
        const { error } = await supabase.from("bm_periods").delete().eq("id", id);
        if (error) return json({ success: false, error: error.message }, 500);
        await broadcastChange(null);
        return json({ success: true });
      }

      return json({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return json({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET ----
  const url = new URL(req.url);

  if (url.searchParams.get("config")) {
    return json({ success: true, config: await getConfig(supabase) });
  }

  // ?period_id=… → the report header, its buyers, and any uploaded line items
  const periodId = url.searchParams.get("period_id");
  if (periodId) {
    const { data: period, error: pErr } = await supabase
      .from("bm_periods").select("*").eq("id", periodId).maybeSingle();
    if (pErr) return json({ success: false, error: pErr.message }, 500);
    if (!period) return json({ success: false, error: "Period not found" }, 404);

    const { data: buyers } = await supabase.from("bm_buyers")
      .select("*").eq("period_id", periodId).order("sort_order", { ascending: true });
    const { data: items } = await supabase.from("bm_items")
      .select("*").eq("period_id", periodId).order("sort_order", { ascending: true });
    return json({ success: true, period, buyers: buyers || [], items: items || [] });
  }

  // [?stores=A,B] → recent periods newest first, plus store status and config.
  const storesParam = url.searchParams.get("stores") || "";
  const stores = storesParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  let q = supabase.from("bm_periods").select("*")
    .order("week_end", { ascending: false }).limit(40);
  if (stores.length) q = q.in("store", stores);
  const { data: periods, error } = await q;
  if (error) return json({ success: false, error: error.message }, 500);

  const statusMap: Record<string, unknown> = {};
  let sq = supabase.from("bm_store_status").select("*");
  if (stores.length) sq = sq.in("store", stores);
  const { data: statuses } = await sq;
  for (const s of (statuses || [])) statusMap[s.store] = s;

  return json({
    success: true,
    data: periods || [],
    store_status: statusMap,
    config: await getConfig(supabase),
  });
});
