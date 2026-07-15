import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Feature-access overrides (feature_overrides table). DM/CEO force individual
// SPEEKS Tools / hotbar links / widgets on or off per role or per user from
// the Feature Access tool; every client fetches the full list at page load and
// resolves user > role > built-in default locally.

function jsonResponse(body: unknown, status = 200) {
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

  if (req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const action = body.action;

      // ---- Force a feature on/off for a role or user; enabled=null clears
      //      the override (back to the built-in default). ----
      if (action === "set_override") {
        const featureKey = String(body.feature_key || "").trim();
        const subjectType = String(body.subject_type || "");
        const subject = String(body.subject || "").trim().toLowerCase();
        if (!featureKey || !subject || !["role", "user"].includes(subjectType)) {
          return jsonResponse({ success: false, error: "feature_key, subject_type (role|user) and subject are required" }, 400);
        }
        // The Feature Access tool must stay reachable for District Managers —
        // otherwise a bad click could lock everyone out of this very tool.
        if (featureKey === "tool-feature-access" && subjectType === "role" &&
            subject === "district-manager" && body.enabled === false) {
          return jsonResponse({ success: false, error: "The Feature Access tool cannot be disabled for District Managers" }, 400);
        }
        if (body.enabled === null || body.enabled === undefined) {
          const { error } = await supabase.from("feature_overrides").delete()
            .eq("feature_key", featureKey).eq("subject_type", subjectType).eq("subject", subject);
          if (error) return jsonResponse({ success: false, error: error.message }, 500);
          return jsonResponse({ success: true });
        }
        const { error } = await supabase.from("feature_overrides").upsert({
          feature_key: featureKey,
          subject_type: subjectType,
          subject,
          enabled: !!body.enabled,
          updated_by: body.updated_by ? String(body.updated_by).trim() : null,
          updated_at: new Date().toISOString(),
        });
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Reset one feature to defaults everywhere (clear all its rows) ----
      if (action === "clear_feature") {
        const featureKey = String(body.feature_key || "").trim();
        if (!featureKey) return jsonResponse({ success: false, error: "Missing feature_key" }, 400);
        const { error } = await supabase.from("feature_overrides").delete().eq("feature_key", featureKey);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      // ---- Clear every override for one user (e.g. they changed roles) ----
      if (action === "clear_user") {
        const subject = String(body.subject || "").trim().toLowerCase();
        if (!subject) return jsonResponse({ success: false, error: "Missing subject" }, 400);
        const { error } = await supabase.from("feature_overrides").delete()
          .eq("subject_type", "user").eq("subject", subject);
        if (error) return jsonResponse({ success: false, error: error.message }, 500);
        return jsonResponse({ success: true });
      }

      return jsonResponse({ success: false, error: "Unknown action" }, 400);
    } catch (err: any) {
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }

  // ---- GET: the full override list (small table; clients cache it) ----
  const { data, error } = await supabase.from("feature_overrides").select("*")
    .order("feature_key", { ascending: true });
  if (error) return jsonResponse({ success: false, error: error.message }, 500);
  return jsonResponse({ success: true, data: data || [] });
});
