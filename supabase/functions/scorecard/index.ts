import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// The SPEEKS Scorecard is now a single section: "Online & Marketing" (the
// former Media and Markets four categories). The other legacy columns remain
// in the table but are no longer written or surfaced.
const BUCKET = {
  name: "Online & Marketing",
  cols: [
    ["online_store_pictures", "Online Store Pictures"],
    ["facebook_listings", "Facebook Listings"],
    ["social_media_posts", "Social Media Posts"],
    ["paymore_sync", "PayMore Sync"],
  ] as [string, string][],
};

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// PayMore Audit Playbook v3 — id → points (165 total). Server recomputes the
// score from this map so the percentage can't be spoofed by the client.
const AUDIT_POINTS: Record<string, number> = {
  ex1:1, ex2:1, ex3:1,
  ef1:1, ef2:1, ef3:1, ef4:1, ef5:1, ef6:2, ef7:1, ef8:1, ef9:1, ef10:2, ef11:1, ef12:1, ef13:1, ef14:3,
  dc1:1, dc2:1, dc3:1, dc4:2, dc5:1, dc6:2, dc7:2, dc8:2, dc9:3, dc10:2, dc11:3, dc12:2,
  rc1:1, rc2:1, rc3:1, rc4:1, rc5:1, rc6:1, rc7:2, rc8:1,
  bt1:3, bt2:1, bt3:2, bt4:2, bt5:1, bt6:1, bt7:2, bt8:3, bt9:7, bt10:3, bt11:3, bt12:4,
  bh1:1, bh2:2, bh3:1, bh4:2, bh5:1, bh6:1, bh7:1, bh8:1, bh9:2, bh10:1, bh11:2, bh12:2, bh13:1, bh14:3,
  bh15:1, bh16:3, bh17:3, bh18:1, bh19:2, bh20:2, bh21:5, bh22:2, bh23:4, bh24:1, bh25:1, bh26:1,
  pa1:1, pa2:1, pa3:1, pa4:1, pa5:1, pa6:1,
  ss1:3, ss2:2, ss3:2, ss4:4, ss5:5, ss6:2, ss7:1, ss8:1, ss9:1, ss10:4, ss11:1, ss12:1, ss13:1,
};
const AUDIT_POSSIBLE = Object.values(AUDIT_POINTS).reduce((a, b) => a + b, 0); // 165

// results[id] is points awarded (0..pts); legacy boolean true = full pts.
function scoreAudit(results: Record<string, unknown>) {
  let earned = 0;
  for (const [id, pts] of Object.entries(AUDIT_POINTS)) {
    const v = results ? (results as any)[id] : 0;
    let a = v === true ? pts : Number(v);
    if (!Number.isFinite(a)) a = 0;
    earned += Math.min(Math.max(a, 0), pts);
  }
  const possible = AUDIT_POSSIBLE;
  const pct = possible ? Math.round((earned / possible) * 1000) / 10 : 0;
  return { earned, possible, pct };
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

      // ---- Submit a practice (PayMore) audit ----
      if (action === "submit_audit") {
        const store = String(body.store || "").toUpperCase();
        const date = body.date;
        if (!store || !date) {
          return new Response(JSON.stringify({ success: false, error: "Missing store or date" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const results = (body.results && typeof body.results === "object") ? body.results : {};
        const { earned, possible, pct } = scoreAudit(results);
        const record = {
          store,
          date,
          auditor_name: body.auditor || null,
          earned_points: earned,
          possible_points: possible,
          pct,
          results,
          section_notes: body.sectionNotes || null,
        };
        await supabase.from("audit_scores").delete().eq("store", store).eq("date", date);
        const { error } = await supabase.from("audit_scores").insert(record);
        if (error) {
          return new Response(JSON.stringify({ success: false, error: error.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ success: true, earned, possible, pct }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ---- Submit the Online & Marketing scorecard ----
      if (action === "submit_scorecard") {
        const store = String(body.store || "").toUpperCase();
        const date = body.date;
        if (!store || !date) {
          return new Response(JSON.stringify({ success: false, error: "Invalid payload" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // scores aligns positionally to BUCKET.cols; sectionNotes[0] is the note.
        const rawScores: any[] = Array.isArray(body.scores) ? body.scores : [];
        const note = Array.isArray(body.sectionNotes) ? body.sectionNotes[0] : (body.notes || null);

        const scoreValues: (number | null)[] = BUCKET.cols.map((_c, i) => {
          const v = rawScores[i];
          return (v === null || v === "" || v === undefined) ? null : Number(v);
        });

        const valid = scoreValues.filter((v) => v !== null) as number[];
        const storeAverage = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

        const dateObj = new Date(date + "T00:00:00Z");
        const record: Record<string, any> = {
          store,
          date,
          month: dateObj.getUTCMonth() + 1,
          year: dateObj.getUTCFullYear(),
          store_average: storeAverage,
          section_0_date: date,
          section_0_notes: (note && String(note).trim()) ? String(note).trim() : null,
        };
        BUCKET.cols.forEach(([col], i) => { record[col] = scoreValues[i]; });

        await supabase.from("scorecards").delete().eq("store", store).eq("date", date);
        const { error } = await supabase.from("scorecards").insert(record);
        if (error) {
          return new Response(JSON.stringify({ success: false, error: error.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ success: false, error: "Unknown action" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (err: any) {
      return new Response(JSON.stringify({ success: false, error: err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  // ---- GET: latest scorecard + latest/previous practice audit per store ----
  const { data: cards, error: cardErr } = await supabase
    .from("scorecards").select("*").order("date", { ascending: false });
  if (cardErr) {
    return new Response(JSON.stringify({ success: false, error: cardErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: audits } = await supabase
    .from("audit_scores").select("*").order("date", { ascending: false });

  const storeData = STORES.map((store) => {
    const latest = (cards || []).find((r: any) => r.store?.toUpperCase() === store);

    let buckets: any[] = [];
    let score = 0;
    let date: string | null = null;
    if (latest) {
      const categories = BUCKET.cols
        .filter(([col]) => latest[col] !== null && latest[col] !== undefined)
        .map(([col, name]) => ({ name, score: latest[col] }));
      const avg = categories.length
        ? categories.reduce((s: number, c: any) => s + parseFloat(c.score), 0) / categories.length
        : 0;
      if (categories.length) {
        buckets = [{
          name: BUCKET.name,
          avg,
          sectionDate: latest.date,
          notes: latest.section_0_notes || null,
          categories,
        }];
      }
      // Headline score is the average of the 4 Online & Marketing categories
      // only — NOT latest.store_average, which on legacy rows still reflects the
      // removed In-Store Operations / Store Reviews sections.
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
      results: latestAudit.results || {},
      prevPct: prevAudit ? prevAudit.pct : null,
    } : null;

    if (!latest && !audit) return null;
    return { store, score, date, buckets, breakdown: [], audit };
  }).filter(Boolean);

  return new Response(JSON.stringify({ success: true, data: storeData }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
