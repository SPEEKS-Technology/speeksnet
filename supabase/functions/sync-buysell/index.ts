import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Pulls the already-computed Buying & Selling payload from the Google Apps Script
// web app (which reads the live spreadsheet) and caches it in Supabase. Run on a
// pg_cron schedule so Supabase owns the refresh cadence -- the Apps Script's old
// push trigger could silently die; this can't (a failed pull just keeps the last
// good payload and logs the error, and the next run self-heals).
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbw3Ms5nc2bhbrjVW-da3xbZ3vKhyBx2TpeR-eSd1L05ZhV-h2Yh0yLmIV_E7TWDmwM69A/exec';
const SYNC_SECRET = 'sp33ks-sync-k3y-2026-x9mq';
const CACHE_KEY = 'buy_sell_hub';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Content-Type': 'application/json',
};

// Realtime "ping": after the cache is refreshed with CHANGED data, tell signed-in
// clients the buying/sales numbers moved so they re-run fetchHubData (which
// re-fetches through the hub fn). Best-effort — never breaks the sync.
async function broadcastChange(tool: string) {
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ topic: 'speeks-notify', event: 'changed', payload: { tool, store: null, ts: Date.now() } }],
      }),
    });
  } catch (_) { /* best-effort */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') || req.headers.get('x-sync-secret');
  if (secret !== SYNC_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  try {
    // Deno fetch follows the Apps Script cross-host 302 redirect chain automatically.
    const res = await fetch(APPS_SCRIPT_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
    const text = await res.text();

    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Apps Script did not return JSON: ' + text.slice(0, 200));
    }

    // Sanity gate: never cache a partial/garbage payload over a good one.
    //
    // ⚠️ GATED ON THE BUY TAB, NOT THE SALES TAB (2026-10-04). It used to demand
    // `ovlRev` and `leaderboard` — both read off the "Sales {Mon} {YY}" tab, which
    // is retired from October 2026 (selling comes off the Net Profit tab now). The
    // hub leaves those keys out when the tab is missing, so from the moment
    // "Sales Oct 26" was deleted (Oct 3, ~2pm Central) every run failed this gate
    // and the cache sat frozen: Saturday's buying reached the Buy tab and never
    // reached the site. The Buy tab is what this cache is for now, so it is what
    // the gate checks — a store's month total and the per-day array.
    if (payload == null || typeof payload !== 'object' || !('ovlBuyVal' in payload)
        || !payload.wkBuy || typeof payload.wkBuy !== 'object' || !Array.isArray(payload.wkBuy.OVL)) {
      throw new Error('Payload missing expected keys (ovlBuyVal / wkBuy)');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Only ping clients when the numbers actually moved vs the cached payload,
    // so a no-op cron run doesn't make every client re-fetch the hub.
    let changed = true;
    try {
      const { data: prev } = await supabase
        .from('app_cache').select('payload').eq('key', CACHE_KEY).maybeSingle();
      if (prev?.payload) changed = JSON.stringify(prev.payload) !== JSON.stringify(payload);
    } catch (_) { /* assume changed on read failure */ }

    const syncedAt = new Date().toISOString();
    const { error } = await supabase
      .from('app_cache')
      .upsert({ key: CACHE_KEY, payload, synced_at: syncedAt }, { onConflict: 'key' });
    if (error) throw error;

    if (changed) await broadcastChange('buying');

    return new Response(
      JSON.stringify({ ok: true, changed, buyDate: payload.ovlBuyDate ?? null, synced_at: syncedAt }),
      { headers: corsHeaders },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
      { status: 500, headers: corsHeaders },
    );
  }
});
