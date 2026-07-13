import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// The 4 original scorecard categories have dedicated numeric columns on
// `scorecards`. Newer/added categories live only in the `scores` jsonb blob.
// We mirror these known keys into their columns on write for back-compat.
const LEGACY_SCORECARD_COLS = new Set([
  "online_store_pictures", "facebook_listings", "social_media_posts", "paymore_sync",
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Catalog management (add/remove/pause items) is DM/CEO only. Submitting
// scores/audits stays open (matches prior behavior); only the catalog mutates here.
function isManagerRole(role?: string): boolean {
  const r = (role || "").toLowerCase().trim();
  return r === "district manager" || r === "district-manager" || r === "ceo";
}

function slugify(s: string): string {
  return String(s || "")
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "item";
}

// Read the score for a scorecard item from a row: prefer the jsonb blob, fall
// back to the legacy per-category column (old rows predate `scores`).
function scoreFromRow(row: any, key: string): number | null {
  const blob = row && row.scores && typeof row.scores === "object" ? row.scores : null;
  let v = blob && blob[key] !== undefined ? blob[key] : (row ? row[key] : undefined);
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Load both catalogs up front — used by GET and by score/audit submits.
  async function loadCatalogs() {
    const [{ data: sc }, { data: au }] = await Promise.all([
      supabase.from("scorecard_items").select("*").order("sort_order", { ascending: true }),
      supabase.from("paymore_audit_items").select("*").order("sort_order", { ascending: true }),
    ]);
    return { scItems: sc || [], auItems: au || [] };
  }

  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const action = body.action;

      // ============ CATALOG MANAGEMENT (DM / CEO only) ============
      if (
        action === "scorecard_item_upsert" || action === "scorecard_item_delete" ||
        action === "audit_item_upsert" || action === "audit_item_delete"
      ) {
        if (!isManagerRole(body.role)) return json({ success: false, error: "Not authorized" }, 403);

        if (action === "scorecard_item_delete") {
          if (!body.id) return json({ success: false, error: "Missing id" }, 400);
          const { error } = await supabase.from("scorecard_items").delete().eq("id", body.id);
          if (error) return json({ success: false, error: error.message }, 500);
          return json({ success: true });
        }

        if (action === "audit_item_delete") {
          if (!body.id) return json({ success: false, error: "Missing id" }, 400);
          const { error } = await supabase.from("paymore_audit_items").delete().eq("id", body.id);
          if (error) return json({ success: false, error: error.message }, 500);
          return json({ success: true });
        }

        if (action === "scorecard_item_upsert") {
          if (body.id) {
            const patch: Record<string, unknown> = {};
            if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
            if (body.max_score !== undefined) patch.max_score = Number(body.max_score) || 5;
            if (body.active !== undefined) patch.active = !!body.active;
            if (body.sort_order !== undefined) patch.sort_order = parseInt(body.sort_order) || 0;
            if (!Object.keys(patch).length) return json({ success: false, error: "Nothing to update" }, 400);
            const { error } = await supabase.from("scorecard_items").update(patch).eq("id", body.id);
            if (error) return json({ success: false, error: error.message }, 500);
            return json({ success: true });
          }
          const label = String(body.label || "").trim();
          if (!label) return json({ success: false, error: "Label is required" }, 400);
          let key = body.item_key ? slugify(body.item_key) : slugify(label);
          // Ensure the key is unique.
          const { data: existing } = await supabase.from("scorecard_items").select("item_key");
          const taken = new Set((existing || []).map((r: any) => r.item_key));
          if (taken.has(key)) { let i = 2; while (taken.has(`${key}_${i}`)) i++; key = `${key}_${i}`; }
          const { data: maxRow } = await supabase.from("scorecard_items")
            .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
          const record = {
            item_key: key,
            label,
            max_score: Number(body.max_score) || 5,
            active: body.active === undefined ? true : !!body.active,
            sort_order: ((maxRow?.sort_order) || 0) + 10,
          };
          const { error } = await supabase.from("scorecard_items").insert(record);
          if (error) return json({ success: false, error: error.message }, 500);
          return json({ success: true, item_key: key });
        }

        if (action === "audit_item_upsert") {
          if (body.id) {
            const patch: Record<string, unknown> = {};
            if (typeof body.section === "string" && body.section.trim()) patch.section = body.section.trim();
            if (typeof body.item_text === "string" && body.item_text.trim()) patch.item_text = body.item_text.trim();
            if (body.points !== undefined) patch.points = Math.max(0, parseInt(body.points) || 0);
            if (body.active !== undefined) patch.active = !!body.active;
            if (body.sort_order !== undefined) patch.sort_order = parseInt(body.sort_order) || 0;
            if (!Object.keys(patch).length) return json({ success: false, error: "Nothing to update" }, 400);
            const { error } = await supabase.from("paymore_audit_items").update(patch).eq("id", body.id);
            if (error) return json({ success: false, error: error.message }, 500);
            return json({ success: true });
          }
          const section = String(body.section || "").trim();
          const text = String(body.item_text || "").trim();
          const points = Math.max(0, parseInt(body.points) || 0);
          if (!section || !text) return json({ success: false, error: "Section and text are required" }, 400);
          // Generate a stable custom item_id (kept out of the ex/ef/... namespace).
          const { data: existing } = await supabase.from("paymore_audit_items").select("item_id");
          const taken = new Set((existing || []).map((r: any) => r.item_id));
          let n = (existing || []).length + 1;
          let itemId = `cst${n}`;
          while (taken.has(itemId)) { n++; itemId = `cst${n}`; }
          const { data: maxRow } = await supabase.from("paymore_audit_items")
            .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
          const record = {
            item_id: itemId,
            section,
            item_text: text,
            points,
            active: body.active === undefined ? true : !!body.active,
            sort_order: ((maxRow?.sort_order) || 0) + 1,
          };
          const { error } = await supabase.from("paymore_audit_items").insert(record);
          if (error) return json({ success: false, error: error.message }, 500);
          return json({ success: true, item_id: itemId });
        }
      }

      // ============ Submit a practice (PayMore) audit ============
      if (action === "submit_audit") {
        const store = String(body.store || "").toUpperCase();
        const date = body.date;
        if (!store || !date) return json({ success: false, error: "Missing store or date" }, 400);

        const { auItems } = await loadCatalogs();
        const activePoints: Record<string, number> = {};
        auItems.forEach((it: any) => { if (it.active) activePoints[it.item_id] = it.points; });
        const possible = Object.values(activePoints).reduce((a, b) => a + b, 0);

        const results = (body.results && typeof body.results === "object") ? body.results : {};
        let earned = 0;
        for (const [id, pts] of Object.entries(activePoints)) {
          const v = (results as any)[id];
          let a = v === true ? pts : Number(v);
          if (!Number.isFinite(a)) a = 0;
          earned += Math.min(Math.max(a, 0), pts);
        }
        const pct = possible ? Math.round((earned / possible) * 1000) / 10 : 0;

        // Per-section notes (object keyed by section title) and photos (object keyed
        // by section title -> array of {url, path, name}). Both optional.
        const sectionNotes = (body.sectionNotes && typeof body.sectionNotes === "object" && !Array.isArray(body.sectionNotes))
          ? body.sectionNotes : null;
        const sectionPhotos = (body.sectionPhotos && typeof body.sectionPhotos === "object" && !Array.isArray(body.sectionPhotos))
          ? body.sectionPhotos : null;

        // Optional time of the walkthrough, 'HH:MM' 24h.
        const auditTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(body.time || "")) ? String(body.time) : null;

        const record = {
          store, date,
          auditor_name: body.auditor || null,
          audit_time: auditTime,
          earned_points: earned,
          possible_points: possible,
          pct,
          results,
          section_notes: sectionNotes,
          section_photos: sectionPhotos,
        };
        await supabase.from("audit_scores").delete().eq("store", store).eq("date", date);
        const { error } = await supabase.from("audit_scores").insert(record);
        if (error) return json({ success: false, error: error.message }, 500);

        // A fresh audit supersedes older ones for this store: delete the previous
        // audits' section photos from storage and clear their references (the scores
        // and history rows are kept). Keeps the bucket to just the latest walkthrough.
        try {
          const { data: priorRows } = await supabase.from("audit_scores")
            .select("id, section_photos").eq("store", store).neq("date", date);
          const paths: string[] = [];
          (priorRows || []).forEach((r: any) => {
            const sp = r.section_photos;
            if (sp && typeof sp === "object") {
              Object.values(sp).forEach((arr: any) => {
                if (Array.isArray(arr)) arr.forEach((p: any) => { if (p && p.path) paths.push(p.path); });
              });
            }
          });
          if (paths.length) {
            await supabase.storage.from("audit-photos").remove(paths);
            await supabase.from("audit_scores").update({ section_photos: null })
              .eq("store", store).neq("date", date);
          }
        } catch (_e) { /* best-effort cleanup — never fail the submit over it */ }

        return json({ success: true, earned, possible, pct });
      }

      // ============ Submit the scorecard ============
      if (action === "submit_scorecard") {
        const store = String(body.store || "").toUpperCase();
        const date = body.date;
        if (!store || !date) return json({ success: false, error: "Invalid payload" }, 400);

        const { scItems } = await loadCatalogs();
        const activeKeys = scItems.filter((i: any) => i.active).map((i: any) => i.item_key);

        // Preferred: body.scores is an object keyed by item_key. Legacy: a
        // positional array aligned to the active items (kept for old clients).
        const scoresObj: Record<string, number | null> = {};
        if (body.scores && typeof body.scores === "object" && !Array.isArray(body.scores)) {
          for (const k of activeKeys) {
            const v = (body.scores as any)[k];
            scoresObj[k] = (v === null || v === "" || v === undefined) ? null : Number(v);
          }
        } else if (Array.isArray(body.scores)) {
          activeKeys.forEach((k: string, i: number) => {
            const v = (body.scores as any[])[i];
            scoresObj[k] = (v === null || v === "" || v === undefined) ? null : Number(v);
          });
        }

        const note = Array.isArray(body.sectionNotes) ? body.sectionNotes[0] : (body.notes || null);
        const provided = Object.values(scoresObj).filter((v) => v !== null) as number[];
        const storeAverage = provided.length ? provided.reduce((a, b) => a + b, 0) / provided.length : null;

        // Persist only non-null scores in the jsonb blob.
        const blob: Record<string, number> = {};
        Object.entries(scoresObj).forEach(([k, v]) => { if (v !== null) blob[k] = v as number; });

        const dateObj = new Date(date + "T00:00:00Z");
        const record: Record<string, any> = {
          store, date,
          month: dateObj.getUTCMonth() + 1,
          year: dateObj.getUTCFullYear(),
          store_average: storeAverage,
          scores: blob,
          section_0_date: date,
          section_0_notes: (note && String(note).trim()) ? String(note).trim() : null,
        };
        // Mirror the 4 known keys into their legacy columns (null-clears the rest).
        LEGACY_SCORECARD_COLS.forEach((col) => { record[col] = scoresObj[col] ?? null; });

        await supabase.from("scorecards").delete().eq("store", store).eq("date", date);
        const { error } = await supabase.from("scorecards").insert(record);
        if (error) return json({ success: false, error: error.message }, 500);
        return json({ success: true });
      }

      return json({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return json({ success: false, error: err.message }, 500);
    }
  }

  // ============ GET: catalog + latest scorecard/audit per store ============
  const { scItems, auItems } = await loadCatalogs();
  const catalog = {
    scorecard_items: scItems.map((i: any) => ({
      id: i.id, item_key: i.item_key, label: i.label,
      max_score: Number(i.max_score), active: !!i.active, sort_order: i.sort_order,
    })),
    audit_items: auItems.map((i: any) => ({
      id: i.id, item_id: i.item_id, section: i.section, item_text: i.item_text,
      points: i.points, active: !!i.active, sort_order: i.sort_order,
    })),
  };
  const activeScItems = scItems.filter((i: any) => i.active);

  const { data: cards, error: cardErr } = await supabase
    .from("scorecards").select("*").order("date", { ascending: false });
  if (cardErr) return json({ success: false, error: cardErr.message }, 500);

  const { data: audits } = await supabase
    .from("audit_scores").select("*").order("date", { ascending: false });

  const storeData = STORES.map((store) => {
    const latest = (cards || []).find((r: any) => r.store?.toUpperCase() === store);

    let buckets: any[] = [];
    let score = 0;
    let date: string | null = null;
    if (latest) {
      const categories = activeScItems
        .map((it: any) => ({ name: it.label, score: scoreFromRow(latest, it.item_key) }))
        .filter((c: any) => c.score !== null);
      const avg = categories.length
        ? categories.reduce((s: number, c: any) => s + c.score, 0) / categories.length
        : 0;
      if (categories.length) {
        buckets = [{
          name: "Online & Marketing",
          avg,
          sectionDate: latest.date,
          notes: latest.section_0_notes || null,
          categories,
        }];
      }
      score = avg;
      date = latest.date;
    }

    const storeAudits = (audits || []).filter((a: any) => a.store?.toUpperCase() === store);
    const latestAudit = storeAudits[0] || null;
    const prevAudit = storeAudits[1] || null;
    const audit = latestAudit ? {
      earned: latestAudit.earned_points,
      possible: latestAudit.possible_points,
      pct: latestAudit.pct,
      date: latestAudit.date,
      auditor: latestAudit.auditor_name,
      time: latestAudit.audit_time || null,
      results: latestAudit.results || {},
      notes: latestAudit.section_notes || null,
      photos: latestAudit.section_photos || null,
      prevPct: prevAudit ? prevAudit.pct : null,
    } : null;

    if (!latest && !audit) return null;
    return { store, score, date, buckets, breakdown: [], audit };
  }).filter(Boolean);

  return json({ success: true, data: storeData, catalog });
});
