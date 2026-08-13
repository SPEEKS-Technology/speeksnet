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

// Realtime "ping": after a successful score/audit submit, tell signed-in clients
// the scorecard changed so they re-run fetchScorecardData (which re-fetches
// through this fn — no table data travels over realtime). Best-effort; a
// broadcast failure can never break the write.
async function broadcastChange(tool: string, store: string | null) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: "speeks-notify", event: "changed", payload: { tool, store: store ? String(store).toUpperCase() : null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort */ }
}

// Drop a row on the email-notification queue — the twin of broadcastChange
// above. That one tells an already-open page to refresh; this one tells the
// people who aren't looking at the site right now.
//
// All this has to do is describe WHO CARES. The notify function resolves
// audience -> people -> their preferences -> an address, and batches whatever is
// outstanding into one message. Leaving audienceStores/audienceRoles null means
// "everybody".
//
// Best-effort and never throws, for the same reason broadcastChange isn't
// awaited for its result: failing to notify must never fail the write itself.
// See migration 0033 for the audience axes and the category list.
async function queueNotification(n: {
  category: string; kind: string; title: string; body?: string; link?: string;
  store?: string | null; audienceStores?: string[] | null; audienceRoles?: string[] | null;
  audienceUser?: string | null; excludeUser?: string | null; priority?: "normal" | "high";
}) {
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    await sb.from("notify_queue").insert({
      category: n.category, kind: n.kind, title: n.title, body: n.body ?? null,
      link: n.link ?? null,
      store: n.store ? String(n.store).toUpperCase() : null,
      audience_stores: n.audienceStores ?? null,
      audience_roles: n.audienceRoles ?? null,
      audience_user: n.audienceUser ? String(n.audienceUser).trim().toLowerCase() : null,
      exclude_user: n.excludeUser ? String(n.excludeUser).trim().toLowerCase() : null,
      priority: n.priority ?? "normal",
    });
  } catch (_) { /* best-effort */ }
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
          await broadcastChange("scorecard", null);
          return json({ success: true });
        }

        if (action === "audit_item_delete") {
          if (!body.id) return json({ success: false, error: "Missing id" }, 400);
          const { error } = await supabase.from("paymore_audit_items").delete().eq("id", body.id);
          if (error) return json({ success: false, error: error.message }, 500);
          await broadcastChange("scorecard", null);
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
            await broadcastChange("scorecard", null);
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
          await broadcastChange("scorecard", null);
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
            await broadcastChange("scorecard", null);
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
          await broadcastChange("scorecard", null);
          return json({ success: true, item_id: itemId });
        }
      }

      // ============ Submit a practice (SPEEKS) audit ============
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
          a = Math.round(a * 2) / 2; // snap to the half-point grid
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

        await broadcastChange("scorecard", store);
        // PayMore PRACTICE audit — the self-scored walkthrough. One of three
        // score submissions that notify (see submit_official_audit and
        // submit_scorecard below); each names WHICH one it was, because "scores
        // were submitted" on its own doesn't tell a DM what to go and look at.
        await queueNotification({
          category: "scores",
          kind: "audit_practice_submitted",
          title: `PayMore audit submitted — ${store}`,
          body: `${earned} of ${possible} points (${Math.round(Number(pct) || 0)}%).`,
          link: "index.html",
          store,
          // DOWN to the store that was walked, not up to corp (Ethan, 2026-08-13).
          // A score is only worth mailing to somebody who can act on it, and the
          // district reads these off the board anyway.
          //
          // NOTE the asymmetry with the official audit below: that one is DM/CEO
          // only to submit, but ANY manager can score their own practice
          // walkthrough - so here excludeUser is the only thing stopping somebody
          // being emailed their own submission.
          audienceStores: [store],
          audienceRoles: ["manager", "owner (manager)", "assistant manager"],
          excludeUser: body.submittedBy ? String(body.submittedBy).trim() : null,
        });
        return json({ success: true, earned, possible, pct });
      }

      // ============ Delete a SPEEKS audit ============
      // For the walkthrough submitted before it was finished. DM/CEO only: any
      // manager may SCORE their own store, but throwing a scored audit away is
      // the district's call, and the audit feeds the store's board and the
      // weekly email.
      //
      // Takes the photos with it. They are only ever referenced by the row being
      // deleted, so leaving them would orphan them in the bucket forever.
      if (action === "delete_audit") {
        if (!isManagerRole(body.role)) return json({ success: false, error: "Not authorized" }, 403);
        const store = String(body.store || "").toUpperCase();
        const date = body.date;
        if (!store || !date) return json({ success: false, error: "Missing store or date" }, 400);

        const { data: row } = await supabase.from("audit_scores")
          .select("id, section_photos").eq("store", store).eq("date", date).maybeSingle();
        if (!row) return json({ success: false, error: "No audit saved for that store and date" }, 404);

        try {
          const paths: string[] = [];
          const sp = row.section_photos;
          if (sp && typeof sp === "object") {
            Object.values(sp).forEach((arr: any) => {
              if (Array.isArray(arr)) arr.forEach((p: any) => { if (p && p.path) paths.push(p.path); });
            });
          }
          if (paths.length) await supabase.storage.from("audit-photos").remove(paths);
        } catch (_e) { /* best-effort — never block the delete on the bucket */ }

        const { error } = await supabase.from("audit_scores")
          .delete().eq("store", store).eq("date", date);
        if (error) return json({ success: false, error: error.message }, 500);
        await broadcastChange("scorecard", store);
        return json({ success: true });
      }

      // ============ Record a REAL PayMore audit ============
      // The one corporate actually runs, as opposed to the practice walkthrough
      // above. Corporate hands over a score and a date and nothing else, so
      // that is all this stores — there is deliberately no results blob, no
      // section notes and no photos to hang a breakdown off.
      //
      // The points scale is the SAME as the practice audit's (the active
      // catalog's total), so the two columns on the district board are read
      // against one set of targets and thresholds. `possible` is therefore
      // derived here rather than accepted from the client: a caller cannot
      // quietly score a store out of a different denominator.
      if (action === "submit_official_audit" || action === "delete_official_audit") {
        // DM/CEO only. Unlike the practice audit — which any manager runs on
        // their own store — this is the district's record of what corporate
        // said, and it is entered in one place by one person.
        if (!isManagerRole(body.role)) return json({ success: false, error: "Not authorized" }, 403);

        const store = String(body.store || "").toUpperCase();
        const date = body.date;
        if (!store || !date) return json({ success: false, error: "Missing store or date" }, 400);

        if (action === "delete_official_audit") {
          const { error } = await supabase.from("paymore_official_audits")
            .delete().eq("store", store).eq("date", date);
          if (error) return json({ success: false, error: error.message }, 500);
          await broadcastChange("scorecard", store);
          return json({ success: true });
        }

        // Usually the SPEEKS Audit's own total, but PayMore has scored some
        // stores out of fewer points, so the caller may name the denominator.
        // A fixed 165 would have reported those stores as having lost points
        // they were never offered (Ethan 2026-08-12).
        //
        // Still validated here rather than trusted: positive, half-point, and
        // bounded. What the caller cannot do is send a denominator that makes
        // the percentage meaningless, because the percentage is what the two
        // audit columns are compared on.
        const { auItems } = await loadCatalogs();
        const fallback = auItems.reduce(
          (a: number, it: any) => a + (it.active ? Number(it.points) || 0 : 0), 0);
        let possible = Number(body.possible);
        if (!Number.isFinite(possible) || possible <= 0) possible = fallback;
        possible = Math.round(possible * 2) / 2;
        if (!possible || possible > 10000) {
          return json({ success: false, error: "Points available must be between 0.5 and 10000" }, 400);
        }

        // Half points, the same grid the practice audit snaps to, and never
        // above the total — a typo'd 1650 would otherwise render as 1000%.
        let earned = Number(body.earned);
        if (!Number.isFinite(earned)) return json({ success: false, error: "Score is required" }, 400);
        earned = Math.min(Math.max(Math.round(earned * 2) / 2, 0), possible);
        const pct = Math.round((earned / possible) * 1000) / 10;

        const record = {
          store, date,
          earned_points: earned,
          possible_points: possible,
          pct,
          entered_by: body.enteredBy ? String(body.enteredBy).slice(0, 120) : null,
        };
        // Re-entering the same store and date corrects it rather than stacking a
        // second row that the "latest" read would have to choose between.
        await supabase.from("paymore_official_audits").delete().eq("store", store).eq("date", date);
        const { error } = await supabase.from("paymore_official_audits").insert(record);
        if (error) return json({ success: false, error: error.message }, 500);
        await broadcastChange("scorecard", store);
        // PayMore OFFICIAL audit — the corporate one, distinct from the practice
        // walkthrough above and the more newsworthy of the two.
        await queueNotification({
          category: "scores",
          kind: "audit_official_submitted",
          title: `PayMore official audit recorded — ${store}`,
          body: `${earned} of ${possible} points (${Math.round(Number(pct) || 0)}%).`,
          link: "index.html",
          store,
          // The DM enters this one, so it can only sensibly travel downward.
          audienceStores: [store],
          audienceRoles: ["manager", "owner (manager)", "assistant manager"],
          excludeUser: body.enteredBy ? String(body.enteredBy).trim() : null,
        });
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
        await broadcastChange("scorecard", store);
        // SPEEKS scorecard — the "Online & Marketing" four categories. Scored out
        // of an average rather than a point total, so it reads differently from
        // the two audits above.
        await queueNotification({
          category: "scores",
          kind: "scorecard_submitted",
          title: `SPEEKS scorecard submitted — ${store}`,
          body: storeAverage === null
            ? "No categories were scored."
            : `Average ${(Math.round(storeAverage * 10) / 10).toFixed(1)} across ${provided.length} categor${provided.length === 1 ? "y" : "ies"}.`,
          link: "index.html",
          store,
          audienceRoles: ["district manager", "ceo", "mocd"],
          excludeUser: body.submittedBy ? String(body.submittedBy).trim() : null,
        });
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

  // The real corporate audits. Every row for every store, newest first — the
  // per-store slice below takes the latest and the one before it, so a store's
  // board can say which way the last real audit moved.
  const { data: official } = await supabase
    .from("paymore_official_audits").select("*").order("date", { ascending: false });

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

    const storeOfficial = (official || []).filter((a: any) => a.store?.toUpperCase() === store);
    const latestOfficial = storeOfficial[0] || null;
    const prevOfficial = storeOfficial[1] || null;
    // Coerced: these three are `numeric` columns, and a numeric can come back as
    // a STRING. "165" + arithmetic downstream is a concatenation bug waiting to
    // happen, and "83.6" > 80 is a string comparison that happens to be right
    // until the day it is "9.5" > "80".
    const officialAudit = latestOfficial ? {
      earned: Number(latestOfficial.earned_points),
      possible: Number(latestOfficial.possible_points),
      pct: Number(latestOfficial.pct),
      date: latestOfficial.date,
      enteredBy: latestOfficial.entered_by || null,
      prevPct: prevOfficial ? Number(prevOfficial.pct) : null,
      prevDate: prevOfficial ? prevOfficial.date : null,
    } : null;

    // A store with nothing but a real audit still gets a row — it is a figure
    // the district is answerable for, and dropping it would make the column
    // read as "not audited" when the truth is "audited, nothing else scored".
    if (!latest && !audit && !officialAudit) return null;
    return { store, score, date, buckets, breakdown: [], audit, officialAudit };
  }).filter(Boolean);

  return json({ success: true, data: storeData, catalog });
});
