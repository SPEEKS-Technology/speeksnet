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
//
// SINCE 0117 the store-held rows are kept by records-watch every morning, and
// the Company rows are company-wide totals it alone writes:
//   - GET leaves Company rows out unless ?company=1. A browser still on the old
//     speeks.js used them as the card headline; without them it falls back to
//     the top store, which is what the headline is supposed to be now.
//   - POST never writes a Company row. The old tool mirrored the top store into
//     that column and saved it, which would overwrite the district total.
//   - POST only touches a row whose value or date actually changed, because the
//     tool sends every cell on every save and an untouched cell must keep the
//     exact day (record_on) the job stamped on it.
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
      .select("id, store, label, value, period, person, ordinal, record_on")
      // ordinal is the DM's hand-picked place on a person board. NULLs sort last
      // so a label that has never been ordered still comes back in a stable
      // order and the frontend's value-descending fallback takes over.
      .order("label").order("ordinal", { ascending: true, nullsFirst: false });
    if (error) return reply({ error: error.message }, 500);

    // store → section and period → subtext for the frontend. `person` is passed
    // straight through: a row that has one is held by that person, and the
    // frontend keys its whole layout off whether it is set.
    const withCompany = url.searchParams.get("company") === "1";
    return reply((data || [])
      .filter((r: any) => withCompany || String(r.store).trim().toLowerCase() !== "company")
      .map((r: any) => ({
      id: r.id,
      section: r.store,
      label: r.label,
      value: r.value,
      subtext: r.period,
      person: r.person,
      ordinal: r.ordinal,
      recordOn: r.record_on,
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

    // Store-held metrics: one UPDATE per (store, label), for the cells that
    // changed. value_num follows the text so records-watch compares against
    // what the DM typed; record_on is cleared because a hand edit names no day.
    if (Array.isArray(body)) {
      const { data: cur } = await supabase
        .from("records").select("store, label, value, period").is("person", null);
      const same = (rec: any) => (cur || []).some((c: any) =>
        c.store === rec.store && c.label === rec.label &&
        String(c.value ?? "").trim() === String(rec.value ?? "").trim() &&
        String(c.period ?? "").trim() === String(rec.date ?? "").trim());
      let written = 0;
      for (const rec of body) {
        if (String(rec.store || "").trim().toLowerCase() === "company") continue;
        if (same(rec)) continue;
        const num = parseFloat(String(rec.value ?? "").replace(/[^0-9.\-]/g, ""));
        await supabase
          .from("records")
          .update({
            value: rec.value, period: rec.date,
            value_num: Number.isFinite(num) ? num : null, record_on: null,
            updated_at: new Date().toISOString(),
          })
          .eq("store", rec.store)
          .eq("label", rec.label)
          .is("person", null);
        written++;
      }
      return reply({ success: true, written });
    }

    return reply({ success: true });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
