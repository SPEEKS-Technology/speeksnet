// ALERTS HUB — one work feed per store phone (docs/alerts-hub-plan.md)
// ---------------------------------------------------------------------------
// PHASE 1 (2026-11-20): delivery only. A phone taps "Turn On Phone Alerts" in
// Settings → Notifications, the browser hands over a push subscription, and
// this function can then push to it. Every later phase (DB rules, reminders
// with a Done tap, the store-inbox reader, the morning digest) ends in the
// same `pushTo()` below, so there is exactly one place a push leaves from.
//
// Browser calls carry the PIN (x-user-pin header or body.pin) and the function
// re-resolves who that is from `users` — the same trust model as notify. Test
// PINs (test_users, 0160) are refused for writes like everywhere else.
// Ops/cron calls carry ?secret= (the house shared secret).
//
//   GET  ?action=key                  → { publicKey }  (VAPID, public by design)
//   GET  (pin)                        → { devices: [...] } for the caller
//   POST { action:'subscribe', subscription, device }   (pin)
//   POST { action:'unsubscribe', endpoint }             (pin)
//   POST { action:'test' }                              (pin) → pushes to the caller's own phones
//   POST ?secret= { action:'send', users?|stores?, title, body?, url?, tag?, source?, rule_key?, urgency? }
//
// Short by rule (Ethan, 2026-11-20): "too many words will cause them not to
// read this." Titles are capped at 60 chars and bodies at 140 here, so nothing
// upstream can quietly send a paragraph to a phone.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPush, type PushSub } from "./webpush.ts";

const SECRET = "sp33ks-sync-k3y-2026-x9mq";
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_JWK") || "";
// The VAPID "sub" claim is how a push service contacts the sender about
// abuse. The site URL rather than a person's address: it is sent to Apple and
// Google on every push.
const VAPID_SUBJECT = "https://speeksnet.com";
const SITE = "https://speeksnet.com/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

// Links stay on our own site: a push is a tap target, and a tap must never be
// able to land somewhere else.
function siteUrl(u: unknown): string {
  const s = String(u || "").trim();
  if (!s) return SITE + "index.html";
  try {
    const abs = new URL(s, SITE);
    return abs.origin === new URL(SITE).origin ? abs.href : SITE + "index.html";
  } catch { return SITE + "index.html"; }
}

async function whoAmI(sb: any, pin: string) {
  if (!pin) return null;
  const { data } = await sb.from("users").select("name, role, store").eq("pin", pin).maybeSingle();
  if (!data) return null;
  let role = String(data.role || "").toLowerCase().trim();
  if (role === "tom") role = "mocd";
  return { name: String(data.name || "").trim(), role, store: String(data.store || "").trim() };
}

function vapid() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error("VAPID keys are not set on the function");
  return { publicKey: VAPID_PUBLIC, privateJwk: JSON.parse(VAPID_PRIVATE), subject: VAPID_SUBJECT };
}

type Msg = { title: string; body?: string; url?: string; tag?: string; source?: string; rule_key?: string; urgency?: string };

// THE one send. Every push in every phase comes through here, is logged one
// row per device, and a dead device is switched off on the spot.
async function pushTo(sb: any, subs: any[], m: Msg) {
  const payload = {
    title: clip(m.title, 60),
    body: clip(m.body, 140),
    url: siteUrl(m.url),
    tag: m.tag ? clip(m.tag, 64) : undefined,
  };
  const keys = vapid();
  const urgency = (["very-low", "low", "normal", "high"].includes(String(m.urgency)) ? m.urgency : "normal") as any;
  const out = await Promise.all(subs.map(async (s) => {
    const r = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth } as PushSub, payload, keys,
      { urgency, topic: payload.tag });
    const now = new Date().toISOString();
    await sb.from("push_subscriptions").update(r.ok
      ? { last_ok_at: now, fail_count: 0, last_error: null }
      : { fail_count: (s.fail_count || 0) + 1, last_error: clip(r.error || `HTTP ${r.status}`, 300), ...(r.gone ? { disabled_at: now } : {}) },
    ).eq("id", s.id);
    await sb.from("alert_log").insert({
      source: m.source || "manual", rule_key: m.rule_key || null,
      user_name: s.user_name, store: s.store, title: payload.title, body: payload.body, url: payload.url,
      tag: payload.tag || null, subscription_id: s.id,
      status: r.ok ? "sent" : (r.gone ? "gone" : "failed"), http_status: r.status || null, error: r.error || null,
    });
    return { device: s.device, user: s.user_name, ok: r.ok, status: r.status, gone: r.gone };
  }));
  return { sent: out.filter((o) => o.ok).length, failed: out.filter((o) => !o.ok).length, results: out };
}

async function activeSubs(sb: any, f: { users?: string[]; stores?: string[] }) {
  const { data, error } = await sb.from("push_subscriptions").select("*").is("disabled_at", null);
  if (error) throw new Error(error.message);
  const users = new Set((f.users || []).map((u) => u.toLowerCase().trim()));
  const stores = new Set((f.stores || []).map((s) => s.toUpperCase().trim()));
  return (data || []).filter((s: any) =>
    users.has(String(s.user_name).toLowerCase().trim()) || stores.has(String(s.store || "").toUpperCase()));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      if (url.searchParams.get("action") === "key") {
        if (!VAPID_PUBLIC) return json({ error: "Phone alerts are not set up yet" }, 503);
        return json({ publicKey: VAPID_PUBLIC });
      }
      const me = await whoAmI(sb, req.headers.get("x-user-pin") || "");
      if (!me) return json({ error: "Sign in again" }, 401);
      const { data } = await sb.from("push_subscriptions")
        .select("id, device, created_at, last_ok_at, endpoint")
        .is("disabled_at", null).eq("user_name", me.name);
      return json({ devices: (data || []).map((d: any) => ({ ...d, endpoint: undefined, endpoint_tail: String(d.endpoint).slice(-12) })) });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // ---- ops / cron: secret-gated ----
    if (action === "send") {
      if (url.searchParams.get("secret") !== SECRET && body.secret !== SECRET) return json({ error: "Unauthorized" }, 401);
      if (!body.title) return json({ error: "title is required" }, 400);
      const subs = await activeSubs(sb, { users: body.users, stores: body.stores });
      if (!subs.length) return json({ sent: 0, failed: 0, results: [], note: "No phone has alerts on for that audience" });
      return json(await pushTo(sb, subs, body));
    }

    // ---- browser: PIN-gated ----
    const me = await whoAmI(sb, req.headers.get("x-user-pin") || String(body.pin || ""));
    if (!me) return json({ error: "Sign in again" }, 401);
    if (me.role === "store") return json({ error: "TV board logins can't get phone alerts" }, 403);

    if (action === "subscribe") {
      const s = body.subscription || {};
      const endpoint = String(s.endpoint || "");
      const p256dh = String(s.keys?.p256dh || "");
      const auth = String(s.keys?.auth || "");
      if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return json({ error: "That phone sent an incomplete subscription" }, 400);
      const row = {
        endpoint, p256dh, auth, user_name: me.name, role: me.role, store: me.store,
        device: clip(body.device, 60) || null, user_agent: clip(req.headers.get("user-agent"), 300) || null,
        updated_at: new Date().toISOString(), disabled_at: null, fail_count: 0, last_error: null,
      };
      const { error } = await sb.from("push_subscriptions").upsert(row, { onConflict: "endpoint" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "unsubscribe") {
      const endpoint = String(body.endpoint || "");
      if (!endpoint) return json({ error: "endpoint is required" }, 400);
      await sb.from("push_subscriptions").update({ disabled_at: new Date().toISOString() })
        .eq("endpoint", endpoint).eq("user_name", me.name);
      return json({ ok: true });
    }

    if (action === "test") {
      const subs = await activeSubs(sb, { users: [me.name] });
      if (!subs.length) return json({ error: "This account has no phone with alerts on yet" }, 404);
      return json(await pushTo(sb, subs, {
        title: "Phone Alerts Are On",
        body: "This is what an alert looks like. Tap to open SPEEKSNET.",
        url: "index.html", tag: "alerts-test", source: "test",
      }));
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
