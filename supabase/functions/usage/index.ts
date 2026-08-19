import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Usage telemetry ingest. The hot path — every signed-in browser posts here a
// few times an hour, so it stays deliberately small: validate, stamp the day,
// upsert, return almost nothing. The report that reads this data lives in a
// SEPARATE function (usage-report) so a bug in the reporting query can never
// take ingest down with it.
//
// No secret and no PIN. Identity is client-asserted in the payload, exactly as
// every other write on this site works (see postWrite in speeks.js) — this is
// adoption telemetry, not an audit log, and the threat model doesn't justify
// making the beacon the only authenticated call in the app.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// A flush carries one row per surface touched this session. A real session tops
// out around 40; anything past this is a bug or someone poking at the endpoint.
const MAX_EVENTS = 300;
const EVENT_KINDS = new Set(["signin", "open", "jump"]);

// Today in STORE time. The edge runtime is UTC, so a naive new Date() rolls the
// day over at 7pm Central — which would file the entire evening under tomorrow
// and, worse, land after the 8pm report had already run. Same class of bug as
// the checklist midnight reset.
function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clean(v: unknown, max = 120): string {
  return String(v ?? "").trim().slice(0, max);
}


// Device facts for the session, stamped onto every row of the flush.
//
// Built field by field with clamps rather than storing the client object as-is.
// This endpoint is unauthenticated by design (see the header note), so nothing
// arbitrary off the wire is allowed to reach the database — an attacker who can
// post here can already forge a user name, but they should not also be able to
// write unbounded JSON into a jsonb column.
const DEVICE_KINDS = new Set(["phone", "tablet", "desktop"]);

function deviceMeta(d: any): Record<string, unknown> | null {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const px = (v: unknown) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 && n <= 20000 ? n : null;
  };
  const dpr = Number(d.dpr);
  const kind = clean(d.kind, 10).toLowerCase();
  return {
    w: px(d.w),
    h: px(d.h),
    dpr: Number.isFinite(dpr) && dpr > 0 && dpr <= 10 ? Math.round(dpr * 100) / 100 : null,
    touch: d.touch === true,
    kind: DEVICE_KINDS.has(kind) ? kind : null,
    mob: d.mob === true,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const user = clean(body.user);
  const sessionId = clean(body.sessionId, 64);
  if (!user) return json({ error: "Missing user" }, 400);
  if (!sessionId) return json({ error: "Missing sessionId" }, 400);

  const role = clean(body.role, 60).toLowerCase();
  const store = clean(body.store, 10).toUpperCase();
  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  const meta = deviceMeta(body.device);
  if (!events.length) return json({ success: true, n: 0 });

  const day = centralToday();
  const rows = events
    .map((e: any) => {
      const event = clean(e.event, 20);
      const feature = clean(e.feature, 80);
      if (!EVENT_KINDS.has(event) || !feature) return null;
      // The client sends the wall-clock time of the FIRST open of this surface,
      // so first/last activity in the report reflects when someone actually did
      // the thing rather than when the 30s flush timer happened to fire.
      const at = Date.parse(e.at);
      return {
        occurred_at: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
        day,
        session_id: sessionId,
        user_name: user,
        user_role: role || null,
        store: store || null,
        event,
        feature,
        label: clean(e.label, 120) || null,
        opens: Math.max(1, Math.min(9999, Number(e.opens) || 1)),
        ...(meta ? { meta } : {}),
      };
    })
    .filter(Boolean);

  if (!rows.length) return json({ success: true, n: 0 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // opens is the session's running total, re-sent whole on every flush, so the
  // upsert overwrites rather than accumulates. occurred_at is likewise pinned to
  // the first open and simply re-asserted.
  const { error } = await supabase
    .from("usage_events")
    .upsert(rows, { onConflict: "session_id,event,feature" });

  if (error) return json({ error: error.message }, 500);
  return json({ success: true, n: rows.length });
});
