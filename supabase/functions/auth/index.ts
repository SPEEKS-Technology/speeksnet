import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Today in STORE time. The edge runtime is UTC, so a naive new Date() would
// stamp a hire date one day early for anyone added after 7pm Central.
function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("users")
      .select("name, pin, store, role, onboarded_at, employment_type, can_float, hire_date")
      .order("name");

    if (error) return json({ error: error.message }, 500);
    return json({ users: data || [] });
  }

  if (req.method === "POST") {
    let users: Array<Record<string, unknown>>;
    try {
      users = JSON.parse(await req.text());
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!Array.isArray(users)) return json({ error: "Expected array" }, 400);

    // ⚠️ THIS IS A FULL REPLACE: every user row is deleted and reinserted from
    // the posted list. Any column the payload does not carry is therefore LOST
    // unless it is explicitly preserved below.
    //
    // That is not theoretical. onboarded_at needed rescuing when it was added,
    // and when employment_type / can_float / hire_date arrived with the listing
    // capacity model they were NOT preserved — so the first save from the User
    // Permissions modal would have quietly put every part-timer back on 40
    // hours, un-floated the floater, and wiped the new-hire ramp, moving every
    // store's listing goal with no error anywhere.
    //
    // If you add a column to users, add it here too, or the modal will eat it.
    const today = centralToday();
    const { data: existing } = await supabase
      .from("users")
      .select("pin, onboarded_at, employment_type, can_float, hire_date");

    const prev = new Map<string, any>();
    (existing || []).forEach((u: any) => prev.set(String(u.pin), u));

    const nowIso = new Date().toISOString();
    const rows = users.map((u: any) => {
      const pin = String(u.pin);
      const was = prev.get(pin);

      // The modal offers one control — Full-time / Part-time / Floater — because
      // those are the three things that set a person's weekly hours. It arrives
      // as employment_type + can_float. When the payload omits them (an older
      // cached client), keep what the row already had.
      const employment_type = typeof u.employment_type === "string"
        ? (u.employment_type === "part_time" ? "part_time" : "full_time")
        : (was?.employment_type ?? "full_time");
      const can_float = typeof u.can_float === "boolean"
        ? u.can_float
        : (was?.can_float ?? false);

      // A brand-new PIN is stamped with today, which starts the two-week
      // new-hire ramp automatically — nobody has to remember to set it. An
      // existing person keeps their date unless the modal explicitly changes it,
      // so re-saving the list can never restart someone's ramp.
      const hire_date = (u.hire_date !== undefined && u.hire_date !== "")
        ? u.hire_date
        : (was ? (was.hire_date ?? null) : today);

      // Announcement catch-up point — see migration 0017. Same rule: existing
      // users keep theirs, a new PIN starts caught up.
      const onboarded_at = was ? was.onboarded_at : nowIso;

      return {
        name: u.name,
        pin: u.pin,
        store: u.store,
        role: u.role,
        onboarded_at,
        employment_type,
        can_float,
        hire_date,
      };
    });

    // Full replace: delete all users, insert fresh list
    await supabase.from("users").delete().neq("pin", "");

    if (rows.length > 0) {
      const { error: insertError } = await supabase.from("users").insert(rows);
      if (insertError) return json({ error: insertError.message }, 500);
    }

    return json({ success: true });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
