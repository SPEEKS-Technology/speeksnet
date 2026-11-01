import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// QuickPortal layouts per person (qp_layouts, 0158). Ethan, 2026-10-25: a
// Customize layout used to live only in the browser, so it did not follow
// anyone to another computer and was lost with the browser's site data.
//
//   GET  ?user=<display name>[&store=BAL] -> { success, found, rows, seen }  (rows null = default page)
//   POST { user, [store,] rows }          -> save the layout (rows null = back to default)
//   POST { user, seen: [...] }            -> widgets now seen in the drawer
//
// A MULTI-STORE MANAGER keeps a layout per store (Ethan, 2026-10-26: "saved by
// user, by store"): the page sends store=, and the layout lives in the row
// "<name>@<store>". Until a store has its own, it starts from the person's
// plain row. The drawer's New marks (seen) stay with the person, in the plain row.
//
// Who is the display name, lower-cased — the site's only identity (no user_id
// anywhere; see CLAUDE.md). A layout is a small JSON list of rows of card keys;
// anything else is refused rather than stored.

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const KEY = /^[a-z0-9:_,.-]{1,80}$/i;
function cleanRows(rows: unknown): { items: string[]; w: number[] | null }[] | null | undefined {
  if (rows === null) return null;
  if (!Array.isArray(rows) || rows.length > 40) return undefined;
  const out = [];
  for (const r of rows as any[]) {
    if (!r || !Array.isArray(r.items) || r.items.length > 6) return undefined;
    const items = r.items.map((k: unknown) => String(k));
    if (items.some((k: string) => !KEY.test(k))) return undefined;
    let w = null;
    if (Array.isArray(r.w)) {
      if (r.w.length !== items.length || r.w.some((n: unknown) => typeof n !== "number" || !isFinite(n) || n <= 0 || n > 10)) return undefined;
      w = r.w;
    }
    out.push({ items, w });
  }
  return out;
}

// A store code, or null for none; undefined = not a store code (refused).
function cleanStore(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().toUpperCase();
  return /^[A-Z]{2,5}$/.test(s) ? s : undefined;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    if (req.method === "POST") {
      const body = JSON.parse(await req.text());
      const name = String(body.user || "").trim();
      const key = name.toLowerCase();
      if (!key || key === "unknown" || key.length > 80) return jsonResponse({ success: false, error: "Missing user" }, 400);
      const store = cleanStore(body.store);
      if (store === undefined) return jsonResponse({ success: false, error: "Bad store" }, 400);
      const now = new Date().toISOString();
      const writes: Record<string, unknown>[] = [];
      if ("rows" in body) {
        const rows = cleanRows(body.rows);
        if (rows === undefined) return jsonResponse({ success: false, error: "Not a layout" }, 400);
        writes.push({ user_key: store ? key + "@" + store : key, user_name: store ? name + " @ " + store : name, rows, updated_at: now });
      }
      if ("seen" in body) {
        if (!Array.isArray(body.seen) || body.seen.length > 100) return jsonResponse({ success: false, error: "Bad seen list" }, 400);
        const seen = body.seen.map((s: unknown) => String(s));
        if (seen.some((s: string) => !KEY.test(s))) return jsonResponse({ success: false, error: "Bad seen list" }, 400);
        const same = writes.find((w) => w.user_key === key);
        if (same) same.seen = seen; else writes.push({ user_key: key, user_name: name, seen, updated_at: now });
      }
      if (!writes.length) return jsonResponse({ success: false, error: "Nothing to save" }, 400);
      for (const w of writes) {
        const { error } = await supabase.from("qp_layouts").upsert(w, { onConflict: "user_key" });
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
      }
      return jsonResponse({ success: true });
    }

    const url = new URL(req.url);
    const key = String(url.searchParams.get("user") || "").trim().toLowerCase();
    if (!key) return jsonResponse({ success: false, error: "Missing user" }, 400);
    const store = cleanStore(url.searchParams.get("store"));
    if (store === undefined) return jsonResponse({ success: false, error: "Bad store" }, 400);
    const keys = store ? [key, key + "@" + store] : [key];
    const { data, error } = await supabase.from("qp_layouts").select("user_key, rows, seen, updated_at").in("user_key", keys);
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
    const plain = (data || []).find((r) => r.user_key === key);
    // A store with no layout of its own yet starts from the plain row's.
    const lay = (store && (data || []).find((r) => r.user_key === key + "@" + store)) || plain;
    // found: false = no layout anywhere for this person — the page may carry an
    // old browser-only layout up the first time (the front end's migration).
    return jsonResponse({ success: true, found: !!lay, rows: lay ? lay.rows : null, seen: plain ? plain.seen : [], updated_at: lay ? lay.updated_at : null });
  } catch (err: any) {
    return jsonResponse({ success: false, error: err.message }, 500);
  }
});
