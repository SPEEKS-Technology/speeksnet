import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// DM/CEO catalog management for the Box Order tool. Managers only read the catalog
// (public anon key); adds/removes go through here on the service role so the public
// key can't mutate the catalog. Frontend gates who sees the Manage Items tab.
const CATEGORIES = [
  "Common Box", "Rare Box", "Very Rare Box",
  "Shipping Supplies", "White Storage Box", "Bubble Mailer",
];

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
  if (req.method !== "POST") return json({ success: false, error: "POST only" }, 405);

  try {
    const body = JSON.parse(await req.text());
    const action = body.action;

    // ---- Add a catalog item ----
    if (action === "add_item") {
      const name = String(body.name || "").trim();
      const category = String(body.category || "").trim();
      if (!name) return json({ success: false, error: "Title is required" }, 400);
      if (!CATEGORIES.includes(category)) return json({ success: false, error: "A valid section is required" }, 400);
      const bundle = Math.max(1, parseInt(body.bundle_size) || 1);
      // Append to the end of the list.
      const { data: maxRow } = await supabase.from("box_order_items")
        .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
      const nextSort = ((maxRow?.sort_order) || 0) + 1;
      const record = {
        name,
        category,
        order_name: body.order_name ? String(body.order_name).trim() : null,
        unit_label: body.unit_label ? String(body.unit_label).trim() : null,
        stores: body.stores ? String(body.stores).trim().toUpperCase() : null, // '' / null = all stores
        bundle_size: bundle,
        is_heavy_duty: false,
        sort_order: nextSort,
      };
      const { error } = await supabase.from("box_order_items").insert(record);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    // ---- Remove a catalog item ----
    if (action === "delete_item") {
      const id = String(body.id || "");
      if (!id) return json({ success: false, error: "Missing id" }, 400);
      const { error } = await supabase.from("box_order_items").delete().eq("id", id);
      if (error) return json({ success: false, error: error.message }, 500);
      return json({ success: true });
    }

    return json({ success: false, error: "Unknown action" }, 400);
  } catch (e: any) {
    return json({ success: false, error: e.message }, 500);
  }
});
