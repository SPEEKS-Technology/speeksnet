// ============================================================================
// records — company records + monthly awards for the Stats & Awards page.
//
//   GET  ?type=awards   the awards list
//   GET                 every record row
//   POST { type:'awards', ... }            save one month's awards
//   POST { type:'person-records', ... }    replace one PERSON-held metric
//   POST [ { store, label, value, date } ] save the store-held metrics
//
// TWO SHAPES OF RECORD, and they cannot share a save path:
//
//   Store-held  — "Daily Buy Record" etc. One row per store per label, so
//                 (store, label) identifies a row and an UPDATE is enough.
//   Person-held — "Single Day Google Reviews". The holder is a person; store
//                 is only where they work. Two people at the same store can
//                 both be on the board, so (store, label) is NOT unique and an
//                 UPDATE keyed on it would overwrite the wrong person. These
//                 are replaced wholesale for the one label instead.
//
// The person replace is scoped to a single label and rewrites every column the
// table has, so it cannot strand a half-written row the way a partial
// full-replace can.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const reply = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  const type = url.searchParams.get("type");

  if (req.method === "GET") {
    if (type === "awards") {
      const { data, error } = await supabase
        .from("awards")
        .select("month, winner1, winner2, winner3, video_url")
        .order("created_at");
      if (error) return reply({ error: error.message }, 500);

      return reply((data || []).map((a: any) => ({
        month: a.month,
        winner1: a.winner1,
        winner2: a.winner2,
        winner3: a.winner3,
        videoUrl: a.video_url,
      })));
    }

    const { data, error } = await supabase
      .from("records")
      .select("id, store, label, value, period, person, ordinal")
      // ordinal is the DM's hand-picked place on a person board. NULLs sort last
      // so a label that has never been ordered still comes back in a stable
      // order and the frontend's value-descending fallback takes over.
      .order("label").order("ordinal", { ascending: true, nullsFirst: false });
    if (error) return reply({ error: error.message }, 500);

    // store → section and period → subtext for the frontend. `person` is passed
    // straight through: a row that has one is held by that person, and the
    // frontend keys its whole layout off whether it is set.
    return reply((data || []).map((r: any) => ({
      id: r.id,
      section: r.store,
      label: r.label,
      value: r.value,
      subtext: r.period,
      person: r.person,
      ordinal: r.ordinal,
    })));
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return reply({ error: "Invalid JSON" }, 400);
    }

    if (body.type === "awards") {
      const { error } = await supabase.from("awards").upsert({
        month: body.month,
        winner1: body.winner1 || null,
        winner2: body.winner2 || null,
        winner3: body.winner3 || null,
        video_url: body.videoUrl || null,
      }, { onConflict: "month" });
      if (error) return reply({ error: error.message }, 500);
      return reply({ success: true });
    }

    // Replace every holder of one person-held metric.
    if (body.type === "person-records") {
      const label = String(body.label || "").trim();
      if (!label) return reply({ error: "label required" }, 400);

      // A person with no name or no number is not a record — drop those rather
      // than writing blank rows the board would then have to filter out.
      // ⚠️ Filter BEFORE numbering, not after. Numbering first and then dropping
      // the blank rows leaves gaps (0,2,3), which still sort correctly today but
      // stop being a usable "place" the moment anything reads them as one.
      const rows = (Array.isArray(body.rows) ? body.rows : [])
        .map((r: any) => ({
          label,
          person: String(r.person ?? "").trim(),
          store: String(r.store ?? "").trim(),
          value: String(r.value ?? "").trim(),
          period: String(r.date ?? "").trim() || null,
        }))
        .filter((r: any) => r.person && r.value)
        // The payload arrives in the DM's chosen order, so the index IS the place.
        .map((r: any, i: number) => ({ ...r, ordinal: i }));

      // Delete first, then insert. Scoped to this one label, so no other metric
      // can be caught by it. If the insert fails the label is left empty rather
      // than half-written — recoverable, and visibly wrong rather than subtly.
      const del = await supabase.from("records").delete().eq("label", label);
      if (del.error) return reply({ error: del.error.message }, 500);

      if (rows.length) {
        const ins = await supabase.from("records").insert(rows);
        if (ins.error) return reply({ error: ins.error.message }, 500);
      }
      return reply({ success: true, written: rows.length });
    }

    // Store-held metrics: one UPDATE per (store, label).
    if (Array.isArray(body)) {
      for (const rec of body) {
        await supabase
          .from("records")
          .update({ value: rec.value, period: rec.date, updated_at: new Date().toISOString() })
          .eq("store", rec.store)
          .eq("label", rec.label)
          .is("person", null);
      }
      return reply({ success: true });
    }

    return reply({ success: true });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
