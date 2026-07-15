import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Every email list the DM can manage from the Email Recipients tool. Anything
// not in this set is rejected so a typo'd key can't create an orphan list.
// - recycle_report:    DM month-end recycle report (mailto To:)
// - box_order_<STORE>: supplier address(es) box orders go to, per store
// - weekly_leadership: Monday weekly report, leadership copy (DM/CEO)
// - weekly_store_<STORE>: Monday weekly report, per-store manager copy
const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const LIST_KEYS = new Set([
  "recycle_report",
  "weekly_leadership",
  ...STORES.map((s) => `box_order_${s}`),
  ...STORES.map((s) => `weekly_store_${s}`),
]);

// Only these roles may add/remove recipients (frontend hides the tool for
// everyone else; this re-checks the REAL role by pin so the gate can't be
// bypassed with a crafted request).
const ADMIN_ROLES = ["ceo", "district manager"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

  // GET: all lists, grouped — { lists: { list_key: [email, ...] } }
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("email_recipients")
      .select("list_key, email")
      .order("created_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);
    const lists: Record<string, string[]> = {};
    (data || []).forEach((r: any) => {
      (lists[r.list_key] = lists[r.list_key] || []).push(r.email);
    });
    return json({ lists });
  }

  // POST: { action: 'add' | 'remove', list_key, email } with x-user-pin auth.
  if (req.method === "POST") {
    const pin = req.headers.get("x-user-pin") || "";
    if (!pin) return json({ error: "Missing x-user-pin header" }, 401);
    const { data: user } = await supabase
      .from("users").select("name, role").eq("pin", pin).single();
    if (!user) return json({ error: "Invalid PIN" }, 401);
    if (!ADMIN_ROLES.includes(String(user.role || "").toLowerCase().trim())) {
      return json({ error: "Insufficient role" }, 403);
    }

    let body: any;
    try { body = JSON.parse(await req.text()); } catch { return json({ error: "Invalid JSON" }, 400); }

    const action = body.action;
    const listKey = String(body.list_key || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (!LIST_KEYS.has(listKey)) return json({ error: "Unknown list" }, 400);
    if (!EMAIL_RE.test(email)) return json({ error: "Invalid email address" }, 400);

    if (action === "add") {
      const { error } = await supabase
        .from("email_recipients")
        .upsert({ list_key: listKey, email }, { onConflict: "list_key,email" });
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (action === "remove") {
      const { error } = await supabase
        .from("email_recipients")
        .delete().eq("list_key", listKey).eq("email", email);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
