import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Margin Guide — serves the buy-ladder catalog to the Operations tab, and takes
// the DM's tier edits.
//
// The catalog is reference data, identical for every store and every user, so
// GET returns the whole thing in one payload (~40 devices, 103 bands, 364
// band/condition rows, ~400 help items, ~230 rebuttals — well under a megabyte)
// and the client caches it for the session. That keeps switching device or
// condition instant, which matters when a buyer is doing this in front of a
// customer.
//
// Editing a tier rewrites every band row using it — that is the whole point of
// the tier model — so writes are DM/CEO only and the ladder shape is enforced
// by a check constraint in the database, not just here.
//
// TWO LAYERS. mg_tiers is the shared ladder; mg_adjustments holds scoped +/- point
// shifts on top of it, for the edits that cut across tiers instead of along them
// ("Laptops can't hold these", "all new-in-box up 5"). GET resolves both into one
// finished set of percentages per cell, so the buying tool never has to know layers
// exist — it reads band.pct[condition] and shows what it is given. See
// 0007_margin_guide_adjustments.sql for why this is a delta and not an override.
//
// THE TEXT IS EDITABLE TOO, and deliberately NOT through a layer. The hero card,
// the three help lists and the rebuttals are keyed by help_key, which is all but
// per-device (2 of 35 keys are shared), so there is no shared-tier problem to
// solve and editing the row is the intent. See 0008_margin_guide_text.sql.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const EDIT_ROLES = ["district-manager", "ceo", "tom"];

// An adjustment applies to a cell when every filter it sets matches. A null filter
// means "any", so {condition: 'NEW'} alone covers new-in-box on all 40 devices.
type Adj = {
  id: number; category: string | null; device_id: number | null;
  condition: string | null; band_id: number | null; delta: number; note: string | null;
};
const adjMatches = (a: Adj, category: string, deviceId: number, cond: string, bandId: number) =>
  (a.category === null || a.category === category) &&
  (a.device_id === null || Number(a.device_id) === deviceId) &&
  (a.condition === null || a.condition === cond) &&
  (a.band_id === null || Number(a.band_id) === bandId);

// Shift all three rungs together, then translate the whole triple back inside
// 1..100 if it has run off an end. Translating rather than clamping each rung
// individually is deliberate: it keeps the gaps between start, team ceiling and
// manager ceiling intact, so an adjusted cell still reads as the same ladder shape
// the buyer has learned. Clamping each rung separately would quietly compress it.
function shiftTriple(s: number, t: number, m: number, delta: number) {
  let a = s + delta, b = t + delta, c = m + delta;
  if (c > 100) { const d = c - 100; a -= d; b -= d; c -= d; }
  if (a < 1) { const d = 1 - a; a += d; b += d; c += d; }
  return { s: Math.max(1, a), t: b, m: Math.min(100, c) };
}

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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (req.method === "GET") {
    const adjRes = await supabase.from("mg_adjustments")
      .select("id, category, device_id, condition, band_id, delta, note").order("id");
    const [tiers, conditions, devices, bands, bandConds, help, rebuttals] = await Promise.all([
      supabase.from("mg_tiers").select("id, slug, name, start_pct, team_pct, mgr_pct").order("sort_order"),
      supabase.from("mg_conditions").select("name, blurb").order("sort_order"),
      supabase.from("mg_devices").select("id, category, device, help_key").eq("active", true).order("sort_order"),
      supabase.from("mg_bands").select("id, device_id, label, price_min, price_max, pay_mode, flat_low, flat_high").order("device_id").order("sort_order"),
      supabase.from("mg_band_conditions").select("band_id, condition, tier_id"),
      // id + sort_order are here for the DM text editor, not the buyer: without
      // them the client can read every line but cannot address a single one, so
      // nothing was editable. They cost ~6KB on a payload already near 120KB.
      supabase.from("mg_help_items").select("id, help_key, kind, body, is_gate, is_must, sort_order").order("help_key").order("kind").order("sort_order"),
      supabase.from("mg_rebuttals").select("id, help_key, name, say, why, conditions, sort_order").order("help_key").order("sort_order"),
    ]);

    const firstError = [adjRes, tiers, conditions, devices, bands, bandConds, help, rebuttals].find((r) => r.error);
    if (firstError?.error) return json({ success: false, error: firstError.error.message }, 500);
    const adjustments = (adjRes.data || []) as Adj[];
    const tierById: Record<number, { start_pct: number; team_pct: number; mgr_pct: number }> = {};
    for (const t of tiers.data || []) tierById[t.id] = t;
    const adjCells: Record<number, number> = {};   // adjustment id -> cells it touches

    // Reshape into what the tool actually asks of it: tiers/conditions keyed for
    // lookup, and every band carrying its own conditions so switching condition
    // is a property read rather than a scan of 364 rows.
    const condsByBand: Record<number, Record<string, number>> = {};
    for (const bc of bandConds.data || []) {
      (condsByBand[bc.band_id] ||= {})[bc.condition] = bc.tier_id;
    }
    // Resolve every cell to the numbers the buyer should actually see: its tier
    // plus the sum of every adjustment matching it. Done here rather than in the
    // client so there is exactly one implementation of the rule, and so the buying
    // tool keeps reading finished percentages without knowing layers exist.
    const deviceById: Record<number, { category: string }> = {};
    for (const d of devices.data || []) deviceById[d.id] = d;

    const bandsByDevice: Record<number, unknown[]> = {};
    for (const b of bands.data || []) {
      const category = deviceById[b.device_id]?.category ?? "";
      const conds = condsByBand[b.id] || {};
      const pct: Record<string, { s: number; t: number; m: number; adj: number }> = {};
      for (const [cond, tierId] of Object.entries(conds)) {
        const tier = tierById[tierId as number];
        if (!tier) continue;
        let delta = 0;
        for (const a of adjustments) {
          if (adjMatches(a, category, b.device_id, cond, b.id)) {
            delta += Number(a.delta);
            adjCells[a.id] = (adjCells[a.id] || 0) + 1;
          }
        }
        const r = delta
          ? shiftTriple(tier.start_pct, tier.team_pct, tier.mgr_pct, delta)
          : { s: tier.start_pct, t: tier.team_pct, m: tier.mgr_pct };
        pct[cond] = { s: r.s, t: r.t, m: r.m, adj: delta };
      }
      (bandsByDevice[b.device_id] ||= []).push({
        id: b.id,
        label: b.label,
        min: Number(b.price_min),
        max: b.price_max === null ? null : Number(b.price_max),
        payMode: b.pay_mode,
        flatLow: b.flat_low === null ? null : Number(b.flat_low),
        flatHigh: b.flat_high === null ? null : Number(b.flat_high),
        conds,
        pct,
      });
    }

    const helpByKey: Record<string, { gates: unknown[]; reminder: unknown[]; condition: unknown[]; testing: unknown[]; rebuttals: unknown[] }> = {};
    const bucket = (k: string) =>
      (helpByKey[k] ||= { gates: [], reminder: [], condition: [], testing: [], rebuttals: [] });
    for (const h of help.data || []) {
      const b = bucket(h.help_key);
      // A gate is a precondition on the purchase, not a tip. It goes above the
      // ladder and is deliberately left out of its own list, so each rule is
      // stated exactly once. It keeps its `kind` because demoting it in the editor
      // has to put it back in the list it came from.
      if (h.is_gate) b.gates.push({ id: h.id, body: h.body, kind: h.kind, must: h.is_must, sort: h.sort_order });
      else (b as any)[h.kind].push({ id: h.id, body: h.body, must: h.is_must, sort: h.sort_order });
    }
    for (const r of rebuttals.data || []) {
      bucket(r.help_key).rebuttals.push({
        id: r.id,
        name: r.name,
        say: r.say,
        why: r.why,
        conds: r.conditions || [],
        sort: r.sort_order,
      });
    }

    return json({
      success: true,
      tiers: tiers.data || [],
      conditions: conditions.data || [],
      devices: (devices.data || []).map((d) => ({
        id: d.id, category: d.category, device: d.device, helpKey: d.help_key,
        bands: bandsByDevice[d.id] || [],
      })),
      help: helpByKey,
      // Carries its own cell count so the editor can say what each one reaches
      // without re-deriving the match rule a second time on the client.
      adjustments: adjustments.map((a) => ({ ...a, cells: adjCells[a.id] || 0 })),
    });
  }

  if (req.method === "POST") {
    let body: any;
    try { body = JSON.parse(await req.text()); }
    catch { return json({ success: false, error: "Invalid JSON" }, 400); }

    const role = String(body.role || "").toLowerCase();
    if (!EDIT_ROLES.includes(role)) {
      return json({ success: false, error: "Not authorized to edit the margin ladder" }, 403);
    }

    // Retune a tier — every band row pointing at it moves with it.
    if (body.action === "saveTier" && body.slug) {
      const start = Number(body.start_pct), team = Number(body.team_pct), mgr = Number(body.mgr_pct);
      if (![start, team, mgr].every(Number.isFinite)) {
        return json({ success: false, error: "All three percentages are required" }, 400);
      }
      if (!(start > 0 && start < team && team < mgr && mgr <= 100)) {
        return json({
          success: false,
          error: "The ladder has to climb: start below team ceiling, team below manager ceiling, nothing over 100%.",
        }, 400);
      }
      const { data: updated, error } = await supabase.from("mg_tiers").update({
        start_pct: start, team_pct: team, mgr_pct: mgr,
        updated_by: body.user || null, updated_at: new Date().toISOString(),
      }).eq("slug", body.slug).select("id");
      if (error) return json({ success: false, error: error.message }, 500);
      const tierId = updated?.[0]?.id;

      // Report how many band rows just moved, so the DM sees the blast radius.
      const { count } = await supabase.from("mg_band_conditions")
        .select("band_id", { count: "exact", head: true })
        .eq("tier_id", tierId ?? -1);
      await broadcastChange("marginguide");
      return json({ success: true, affected: count ?? null });
    }

    // Point one band/condition cell at a different tier, or clear it (which is
    // how "we don't buy this condition here" gets expressed).
    if (body.action === "assignTier" && body.band_id && body.condition) {
      if (body.tier_id === null) {
        const { error } = await supabase.from("mg_band_conditions")
          .delete().eq("band_id", body.band_id).eq("condition", body.condition);
        if (error) return json({ success: false, error: error.message }, 500);
      } else {
        const { error } = await supabase.from("mg_band_conditions").upsert({
          band_id: body.band_id, condition: body.condition, tier_id: body.tier_id,
        }, { onConflict: "band_id,condition" });
        if (error) return json({ success: false, error: error.message }, 500);
      }
      await broadcastChange("marginguide");
      return json({ success: true });
    }

    // Layer a scoped shift on top of the shared ladder. This is how a category
    // that can't hold the standard numbers, or a blanket move on one condition,
    // gets expressed without forking tiers.
    if (body.action === "saveAdjustment") {
      const delta = Number(body.delta);
      if (!Number.isFinite(delta) || delta === 0) {
        return json({ success: false, error: "Give the adjustment a non-zero number of points" }, 400);
      }
      if (Math.abs(delta) > 60) {
        return json({ success: false, error: "Adjustments are limited to 60 points either way" }, 400);
      }
      const row = {
        category: body.category ? String(body.category) : null,
        device_id: body.device_id ? Number(body.device_id) : null,
        condition: body.condition ? String(body.condition) : null,
        band_id: body.band_id ? Number(body.band_id) : null,
        delta: Math.round(delta),
        note: body.note ? String(body.note) : null,
        created_by: body.user || null,
      };
      if (!row.category && !row.device_id && !row.condition && !row.band_id) {
        return json({
          success: false,
          error: "Narrow it down first — an adjustment with no scope would move the whole ladder, which is what editing a tier is for.",
        }, 400);
      }
      const { data, error } = await supabase.from("mg_adjustments").insert(row).select("id").single();
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("marginguide");
      return json({ success: true, id: data?.id ?? null });
    }

    if (body.action === "deleteAdjustment" && body.id) {
      const { error } = await supabase.from("mg_adjustments").delete().eq("id", Number(body.id));
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("marginguide");
      return json({ success: true });
    }

    // ---------------------------------------------------------------------
    // COACHING TEXT: the hero card, the three help lists, and the rebuttals.
    //
    // These are direct edits, unlike the percentages, because help_key is
    // effectively per-device (2 of 35 keys are shared). The client tells the DM
    // how many items a block of text reaches before they save; see 0008.
    // ---------------------------------------------------------------------

    const HELP_KINDS = ["reminder", "condition", "testing"];

    // Rewrite a group's sort_order as 0..n-1 in the given id order. The seed
    // never guaranteed distinct sort values inside a group, so "swap the two
    // numbers" would silently do nothing whenever neighbours were tied. Writing
    // the whole sequence is immune to that, and groups are tiny (~4 rows).
    async function resequence(table: string, ids: number[]) {
      for (let i = 0; i < ids.length; i++) {
        const { error } = await supabase.from(table).update({ sort_order: i }).eq("id", ids[i]);
        if (error) return error.message;
      }
      return null;
    }

    // Ordered ids of the group a help item belongs to. A gate is displayed out of
    // its own kind list, so is_gate is part of the group identity: the hero card
    // and the list it was promoted from order independently.
    async function helpGroup(help_key: string, kind: string, is_gate: boolean) {
      const { data } = await supabase.from("mg_help_items")
        .select("id").eq("help_key", help_key).eq("kind", kind).eq("is_gate", is_gate)
        .order("sort_order").order("id");
      return (data || []).map((r) => r.id as number);
    }

    if (body.action === "saveHelpItem") {
      const text = String(body.body ?? "").trim();
      if (!text) return json({ success: false, error: "The text can't be empty" }, 400);
      if (text.length > 600) return json({ success: false, error: "Keep it under 600 characters — this renders as a bullet a buyer reads mid-deal" }, 400);
      const kind = String(body.kind || "");
      if (!HELP_KINDS.includes(kind)) return json({ success: false, error: "Unknown help kind" }, 400);

      const patch = {
        body: text,
        kind,
        is_gate: !!body.is_gate,
        // A gate is already rendered as a hard precondition in the hero card;
        // is_must would be a second emphasis on something that isn't in a list
        // to be emphasised within. Keep the two flags mutually exclusive.
        is_must: body.is_gate ? false : !!body.is_must,
        updated_by: body.user || null,
        updated_at: new Date().toISOString(),
      };

      if (body.id) {
        const { error } = await supabase.from("mg_help_items").update(patch).eq("id", Number(body.id));
        if (error) return json({ success: false, error: error.message }, 500);
        await broadcastChange("marginguide");
        return json({ success: true, id: Number(body.id) });
      }

      const help_key = String(body.help_key || "");
      if (!help_key) return json({ success: false, error: "Which item is this for?" }, 400);
      const group = await helpGroup(help_key, kind, patch.is_gate);
      const { data, error } = await supabase.from("mg_help_items")
        .insert({ ...patch, help_key, sort_order: group.length })
        .select("id").single();
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("marginguide");
      return json({ success: true, id: data?.id ?? null });
    }

    if (body.action === "deleteHelpItem" && body.id) {
      const { error } = await supabase.from("mg_help_items").delete().eq("id", Number(body.id));
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("marginguide");
      return json({ success: true });
    }

    // Promote a tip into the "Before you buy" hero card, or send it back down.
    // The row keeps its kind and text; only is_gate moves. It lands at the end
    // of whichever group it arrives in, and the group it left is resequenced so
    // it has no gap.
    if (body.action === "setHelpGate" && body.id) {
      const id = Number(body.id);
      const gate = !!body.is_gate;
      const { data: row, error: readErr } = await supabase.from("mg_help_items")
        .select("help_key, kind, is_gate").eq("id", id).single();
      if (readErr || !row) return json({ success: false, error: readErr?.message || "No such item" }, 404);
      if (!!row.is_gate === gate) return json({ success: true, id, unchanged: true });

      const arriving = await helpGroup(row.help_key, row.kind, gate);
      const patch: Record<string, unknown> = {
        is_gate: gate,
        sort_order: arriving.length,
        updated_by: body.user || null,
        updated_at: new Date().toISOString(),
      };
      // Promoting clears is_must (the hero card is already the strong statement);
      // demoting leaves it alone, so the key is omitted rather than set null.
      if (gate) patch.is_must = false;
      const { error } = await supabase.from("mg_help_items").update(patch).eq("id", id);
      if (error) return json({ success: false, error: error.message }, 500);

      const leftBehind = (await helpGroup(row.help_key, row.kind, !gate)).filter((x) => x !== id);
      const seqErr = await resequence("mg_help_items", leftBehind);
      if (seqErr) return json({ success: false, error: seqErr }, 500);
      await broadcastChange("marginguide");
      return json({ success: true, id });
    }

    if (body.action === "moveHelpItem" && body.id) {
      const id = Number(body.id);
      const dir = Number(body.dir) < 0 ? -1 : 1;
      const { data: row, error: readErr } = await supabase.from("mg_help_items")
        .select("help_key, kind, is_gate").eq("id", id).single();
      if (readErr || !row) return json({ success: false, error: readErr?.message || "No such item" }, 404);

      const ids = await helpGroup(row.help_key, row.kind, !!row.is_gate);
      const at = ids.indexOf(id), to = at + dir;
      if (at < 0 || to < 0 || to >= ids.length) return json({ success: true, id, unchanged: true });
      [ids[at], ids[to]] = [ids[to], ids[at]];
      const seqErr = await resequence("mg_help_items", ids);
      if (seqErr) return json({ success: false, error: seqErr }, 500);
      await broadcastChange("marginguide");
      return json({ success: true, id });
    }

    if (body.action === "saveRebuttal") {
      const name = String(body.name ?? "").trim();
      const why = String(body.why ?? "").trim();
      // Empty `say` means "no scripted line, fall back to why" — that has to be
      // NULL, not "", or the tool renders an empty quote. Mirrors the 0008 check.
      const sayRaw = String(body.say ?? "").trim();
      const say = sayRaw || null;
      if (!name) return json({ success: false, error: "Give the rebuttal a name — that's the heading a buyer scans for" }, 400);
      if (!why) return json({ success: false, error: "The business reason is required; it's what a buyer falls back on when pushed" }, 400);
      if (name.length > 120) return json({ success: false, error: "Keep the name under 120 characters" }, 400);
      if (why.length > 800 || (say && say.length > 800)) return json({ success: false, error: "Keep each passage under 800 characters" }, 400);

      // An unknown condition tag would make the rebuttal silently unreachable:
      // the client only ever shows rows tagged for the selected grade.
      const { data: condRows } = await supabase.from("mg_conditions").select("name");
      const known = new Set((condRows || []).map((c) => c.name as string));
      const conditions = Array.isArray(body.conditions)
        ? [...new Set(body.conditions.map((c: unknown) => String(c)))]
        : [];
      const unknown = conditions.filter((c) => !known.has(c));
      if (unknown.length) return json({ success: false, error: `Unknown condition${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}` }, 400);

      const patch = {
        name, say, why, conditions,
        updated_by: body.user || null,
        updated_at: new Date().toISOString(),
      };

      if (body.id) {
        const { error } = await supabase.from("mg_rebuttals").update(patch).eq("id", Number(body.id));
        if (error) return json({ success: false, error: error.message }, 500);
        await broadcastChange("marginguide");
        return json({ success: true, id: Number(body.id) });
      }

      const help_key = String(body.help_key || "");
      if (!help_key) return json({ success: false, error: "Which item is this for?" }, 400);
      const { data: sibs } = await supabase.from("mg_rebuttals").select("id").eq("help_key", help_key);
      const { data, error } = await supabase.from("mg_rebuttals")
        .insert({ ...patch, help_key, sort_order: (sibs || []).length })
        .select("id").single();
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("marginguide");
      return json({ success: true, id: data?.id ?? null });
    }

    if (body.action === "deleteRebuttal" && body.id) {
      const { error } = await supabase.from("mg_rebuttals").delete().eq("id", Number(body.id));
      if (error) return json({ success: false, error: error.message }, 500);
      await broadcastChange("marginguide");
      return json({ success: true });
    }

    if (body.action === "moveRebuttal" && body.id) {
      const id = Number(body.id);
      const dir = Number(body.dir) < 0 ? -1 : 1;
      const { data: row, error: readErr } = await supabase.from("mg_rebuttals")
        .select("help_key").eq("id", id).single();
      if (readErr || !row) return json({ success: false, error: readErr?.message || "No such rebuttal" }, 404);
      const { data: sibs } = await supabase.from("mg_rebuttals")
        .select("id").eq("help_key", row.help_key).order("sort_order").order("id");
      const ids = (sibs || []).map((r) => r.id as number);
      const at = ids.indexOf(id), to = at + dir;
      if (at < 0 || to < 0 || to >= ids.length) return json({ success: true, id, unchanged: true });
      [ids[at], ids[to]] = [ids[to], ids[at]];
      const seqErr = await resequence("mg_rebuttals", ids);
      if (seqErr) return json({ success: false, error: seqErr }, 500);
      await broadcastChange("marginguide");
      return json({ success: true, id });
    }

    return json({ success: false, error: "Unknown action" }, 400);
  }

  return json({ success: false, error: "Method not allowed" }, 405);
});
