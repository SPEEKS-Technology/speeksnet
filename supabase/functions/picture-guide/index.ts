import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Picture Guide — serves the photo sheets to the Operations tab, and takes the
// DM's edits to them.
//
// The sheets are reference data: identical for every store and every user, no
// per-store rows, nothing derived from who is asking. So GET returns the lot in
// one payload (a dozen or so categories, ~15 shots each — a few KB of text plus
// public image URLs) and the client caches it for the session. A lister
// switching category mid-item gets a redraw, never a spinner.
//
// WHAT IS NOT IN THE PAYLOAD: shot numbers. The sheet stores order and a
// conditional flag; which position a shot actually occupies depends on the item
// in the lister's hand and is worked out at render time. See the migration
// header for why that is the entire reason this tool exists.
//
// Writes are DM/CEO only and go one row at a time. There is no bulk-save: a DM
// editing a sheet is doing one thing at a time (rename a shot, move it up, swap
// its photo), and a save button holding a basket of unrelated edits is how you
// get someone's half-finished thought published because they clicked the wrong
// exit.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Two spellings of the same role exist in the codebase: the session stores
// "district manager" (a space), Feature Access keys it "district-manager".
// Normalize rather than pick a side — the Margin Guide shipped broken for every
// DM for exactly this reason, so the fix is copied here deliberately.
const EDIT_ROLES = ["district-manager", "ceo", "mocd", "tom"];
const normRole = (r: unknown) =>
  String(r ?? "").toLowerCase().trim().replace(/[\s_]+/g, "-");

const slugify = (s: string) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// sort_order in tens, so inserting between two rows never needs a renumber.
const STEP = 10;

async function broadcastChange(tool: string) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort: never fail a write over a ping */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const publicUrl = (p: string | null) =>
    p ? `${SUPABASE_URL}/storage/v1/object/public/picture-guide/${p}` : null;

  // --------------------------------------------------------------------------
  if (req.method === "GET") {
    const [cats, shots] = await Promise.all([
      supabase.from("pg_categories")
        .select("id, slug, name, sort_order, updated_at, updated_by")
        .eq("active", true).order("sort_order").order("id"),
      supabase.from("pg_shots")
        .select("id, category_id, label, cond_label, repeatable, note, image_path, sort_order")
        .order("category_id").order("sort_order").order("id"),
    ]);
    const bad = [cats, shots].find((r) => r.error);
    if (bad?.error) return json({ success: false, error: bad.error.message }, 500);

    const byCat: Record<number, unknown[]> = {};
    for (const s of shots.data || []) {
      (byCat[s.category_id] ||= []).push({
        id: s.id,
        label: s.label,
        cond: s.cond_label,          // null => always taken
        rep: !!s.repeatable,
        note: s.note,
        path: s.image_path,
        img: publicUrl(s.image_path),
      });
    }
    return json({
      success: true,
      categories: (cats.data || []).map((c) => ({
        id: c.id, slug: c.slug, name: c.name,
        updatedAt: c.updated_at, updatedBy: c.updated_by,
        shots: byCat[c.id] || [],
      })),
    });
  }

  // --------------------------------------------------------------------------
  if (req.method === "POST") {
    let body: any;
    try { body = JSON.parse(await req.text()); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400); }

    if (!EDIT_ROLES.includes(normRole(body.role))) {
      return json({ success: false, error: "Not authorized to edit the Picture Guide" }, 403);
    }
    const who = body.user || null;
    const stamp = { updated_by: who, updated_at: new Date().toISOString() };
    const ok = async (extra: Record<string, unknown> = {}) => {
      await broadcastChange("pictureguide");
      return json({ success: true, ...extra });
    };

    // ---- categories --------------------------------------------------------
    if (body.action === "saveCategory") {
      const name = String(body.name || "").trim();
      if (!name) return json({ success: false, error: "A category needs a name" }, 400);

      if (body.id) {
        const { error } = await supabase.from("pg_categories")
          .update({ name, ...stamp }).eq("id", body.id);
        if (error) return json({ success: false, error: error.message }, 500);
        return await ok();
      }
      // New categories land at the end. A DM who wants it elsewhere moves it,
      // which is one obvious action, rather than guessing a position at create
      // time from a name.
      const { data: last } = await supabase.from("pg_categories")
        .select("sort_order").order("sort_order", { ascending: false }).limit(1);
      const { data, error } = await supabase.from("pg_categories").insert({
        slug: `${slugify(name) || "category"}-${Date.now().toString(36)}`,
        name, sort_order: (last?.[0]?.sort_order ?? 0) + STEP, ...stamp,
      }).select("id, slug").single();
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("pictureguide");
      return json({ success: true, id: data.id, slug: data.slug });
    }

    // Soft delete. The shots stay, so a category removed by mistake comes back
    // whole — and so nothing silently orphans images that other rows may share.
    if (body.action === "deleteCategory" && body.id) {
      const { error } = await supabase.from("pg_categories")
        .update({ active: false, ...stamp }).eq("id", body.id);
      if (error) return json({ success: false, error: error.message }, 500);
      return await ok();
    }

    // ---- shots -------------------------------------------------------------
    if (body.action === "saveShot") {
      const label = String(body.label || "").trim();
      if (!label) return json({ success: false, error: "A shot needs a name" }, 400);
      const cond = body.cond === null || body.cond === undefined || String(body.cond).trim() === ""
        ? null : String(body.cond).trim();
      // Mirrors the pg_shots_repeat_needs_cond check: an always-taken shot
      // cannot be repeatable, because "as many as you need" has no meaning for
      // a shot every item gets exactly one of. Coerced rather than rejected —
      // flipping a repeatable shot to Always is a normal edit, not an error.
      const rep = cond ? !!body.rep : false;
      const patch: Record<string, unknown> = {
        label, cond_label: cond, repeatable: rep,
        note: body.note ? String(body.note).trim() : null,
        ...stamp,
      };
      // Absent means "leave the photo alone"; explicit null means "remove it".
      if ("path" in body) patch.image_path = body.path || null;

      if (body.id) {
        const { error } = await supabase.from("pg_shots").update(patch).eq("id", body.id);
        if (error) return json({ success: false, error: error.message }, 500);
        return await ok();
      }
      if (!body.category_id) return json({ success: false, error: "Which category?" }, 400);
      const { data: last } = await supabase.from("pg_shots")
        .select("sort_order").eq("category_id", body.category_id)
        .order("sort_order", { ascending: false }).limit(1);
      const { data, error } = await supabase.from("pg_shots").insert({
        category_id: body.category_id, sort_order: (last?.[0]?.sort_order ?? 0) + STEP, ...patch,
      }).select("id").single();
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("pictureguide");
      return json({ success: true, id: data.id });
    }

    if (body.action === "deleteShot" && body.id) {
      const { error } = await supabase.from("pg_shots").delete().eq("id", body.id);
      if (error) return json({ success: false, error: error.message }, 500);
      return await ok();
    }

    // Reorder takes the WHOLE category's ids in their new order, not a "move up"
    // on one row. Two DMs nudging the same sheet from stale views can otherwise
    // interleave into an order neither of them chose; sending the full sequence
    // means the last save wins outright and the sheet always reads as somebody's
    // actual intent.
    if (body.action === "reorderShots" && Array.isArray(body.ids)) {
      const ids = body.ids.map(Number).filter(Number.isFinite);
      if (!ids.length) return json({ success: false, error: "Nothing to reorder" }, 400);
      const results = await Promise.all(ids.map((id, i) =>
        supabase.from("pg_shots").update({ sort_order: (i + 1) * STEP, ...stamp }).eq("id", id)
      ));
      const failed = results.find((r) => r.error);
      if (failed?.error) return json({ success: false, error: failed.error.message }, 500);
      return await ok();
    }

    if (body.action === "reorderCategories" && Array.isArray(body.ids)) {
      const ids = body.ids.map(Number).filter(Number.isFinite);
      if (!ids.length) return json({ success: false, error: "Nothing to reorder" }, 400);
      const results = await Promise.all(ids.map((id, i) =>
        supabase.from("pg_categories").update({ sort_order: (i + 1) * STEP, ...stamp }).eq("id", id)
      ));
      const failed = results.find((r) => r.error);
      if (failed?.error) return json({ success: false, error: failed.error.message }, 500);
      return await ok();
    }

    return json({ success: false, error: `Unknown action: ${body.action}` }, 400);
  }

  return json({ success: false, error: "Method not allowed" }, 405);
});
