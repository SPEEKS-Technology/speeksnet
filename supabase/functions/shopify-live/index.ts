// ============================================================================
// shopify-live — live store metrics for the Live Dashboard tab.
//
// Two entry points, deliberately separated:
//
//   ?secret=<sync>   pg_cron, once a minute. Talks to Shopify, writes app_cache,
//                    broadcasts on change. The ONLY path that calls Shopify.
//   x-user-pin       the browser. Reads the cache and scopes it to that person's
//                    store. Never calls Shopify, never sees a token.
//
// Shopify tokens live in shopify_stores (service-role only) and are never
// returned, logged, or reachable from the client. A store's numbers are chosen
// by the pin's OWN store on the server, so hiding a tab in the frontend is not
// load-bearing.
//
// REFRESH WINDOW (America/Chicago, computed here so DST needs no second cron)
//   Stores open 10-7 Mon-Fri, 10-4 Sat, closed Sun. A two-hour buffer each side
//   covers people arriving early and closing late:
//       Mon-Fri 08:00-21:00   Sat 08:00-18:00   Sun: closed
//   Inside the window: refresh every minute.
//   Outside it: refresh only if the cache is over 5 minutes stale, which is what
//   "every five minutes after close" means without a second schedule.
//
// COST: one ShopifyQL query plus one last-order query per store, ~4 points each
// against a 2000-point bucket restoring at 100/s. A per-minute pass over five
// stores is nowhere near a limit.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Machine auth (pg_cron only). Deliberately NOT present in speeks.js: this same
// secret guards weekly-report, which emails real store managers, and the Gmail
// relay. The browser gets the pin path instead.
const SECRET = "sp33ks-sync-k3y-2026-x9mq";

const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") || "2026-07";
const CACHE_KEY = "shopify_live";
const TZ = "America/Chicago";

// Stale threshold for the closed-hours cadence.
const CLOSED_STALE_MS = 5 * 60 * 1000;

// shop domain -> the store code used everywhere else on the site.
const SHOP_TO_CODE: Record<string, string> = {
  "paymore-overland-park.myshopify.com": "OVL",
  "paymore-lees-summit.myshopify.com": "LEE",
  "paymore-westport.myshopify.com": "WSP",
  "paymore-maplewood.myshopify.com": "MPL",
  "paymore-ballwin.myshopify.com": "BAL",
};
const STORE_ORDER = ["OVL", "LEE", "WSP", "MPL", "BAL"];
const STORE_NAMES: Record<string, string> = {
  OVL: "Overland Park", LEE: "Lees Summit", WSP: "Westport",
  MPL: "Maplewood", BAL: "Ballwin",
};

// Everyone at CORP sees the district. Kept as a role list too, because role and
// store have drifted apart before (see the KPI role-gate bug).
const DISTRICT_ROLES = ["ceo", "district manager", "tom"];
// The Multi-Store Manager runs BAL and MPL, and sees both stacked — the same
// scoping the checklist, audit panel and Listing Goals already use.
const MSM_STORES = ["BAL", "MPL"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// --- Central-time helpers ---------------------------------------------------
// The edge runtime is UTC. Every date decision here goes through Intl with an
// explicit timeZone, so "today" means the store's today and DST is not our
// problem. (A naive new Date() rolls the day over at 7pm Central — that exact
// bug reset checklists a day early.)

type Central = { y: number; m: number; d: number; hour: number; minute: number; dow: number };

function centralNow(now: Date): Central {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    // Intl gives hour "24" at midnight with hour12:false in some runtimes.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

/** Is the buffered trading window open right now? */
function isOpen(c: Central): boolean {
  if (c.dow === 0) return false;                       // closed Sunday
  if (c.dow === 6) return c.hour >= 8 && c.hour < 18;  // Sat 10-4 + buffer
  return c.hour >= 8 && c.hour < 21;                   // Mon-Fri 10-7 + buffer
}

/**
 * Selling days in the month, and how many have elapsed including today.
 *
 * Calendar days would understate progress because the stores are shut on
 * Sundays — "17% of goal on day 5" only reads correctly next to how much of the
 * SELLING month has actually gone.
 */
function sellingDays(c: Central): { total: number; elapsed: number } {
  const inMonth = new Date(Date.UTC(c.y, c.m, 0)).getUTCDate();
  let total = 0, elapsed = 0;
  for (let d = 1; d <= inMonth; d++) {
    if (new Date(Date.UTC(c.y, c.m - 1, d)).getUTCDay() === 0) continue;
    total++;
    if (d <= c.d) elapsed++;
  }
  return { total, elapsed };
}

const iso = (c: Central) =>
  `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;

// --- Shopify ----------------------------------------------------------------

async function gql(shop: string, token: string, query: string) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch (_) { /* surfaced by the caller */ }
  // Shopify answers 200 with an `errors` array for a bad query, so status alone
  // proves nothing.
  if (!res.ok || !parsed || parsed.errors) {
    throw new Error(
      `${res.status} ${JSON.stringify(parsed?.errors ?? text.slice(0, 160))}`,
    );
  }
  return parsed.data;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

type StoreMetrics = {
  code: string; name: string;
  netToday: number; cogsToday: number; gpToday: number; ordersToday: number;
  returnsToday: number; marginToday: number | null; aov: number | null;
  mtdNet: number; mtdCogs: number; mtdGp: number; mtdOrders: number;
  mtdMargin: number | null;
  goal: number; pctOfGoal: number | null; paceIndex: number | null;
  lastOrderAt: string | null; lastOrderAmount: number | null;
  error?: string;
};

async function fetchStore(
  shop: string, token: string, c: Central, goal: number,
): Promise<StoreMetrics> {
  const code = SHOP_TO_CODE[shop] ?? shop;
  const base: StoreMetrics = {
    code, name: STORE_NAMES[code] ?? code,
    netToday: 0, cogsToday: 0, gpToday: 0, ordersToday: 0, returnsToday: 0,
    marginToday: null, aov: null,
    mtdNet: 0, mtdCogs: 0, mtdGp: 0, mtdOrders: 0, mtdMargin: null,
    goal, pctOfGoal: null, paceIndex: null,
    lastOrderAt: null, lastOrderAmount: null,
  };

  try {
    // One query covers today AND month-to-date: -Nd back to the 1st, grouped by
    // day. cost_of_goods_sold rather than net_sales - gross_profit, which
    // disagrees on about half of all days and would put the dashboard at odds
    // with the Sales Summary sheet staff already compare against.
    const sinceDays = c.d - 1;
    const data = await gql(shop, token, `{
      shopifyqlQuery(query: "FROM sales SHOW net_sales, cost_of_goods_sold, orders, returns GROUP BY day SINCE -${sinceDays}d UNTIL today ORDER BY day") {
        parseErrors
        tableData { rows }
      }
      orders(first: 1, reverse: true, sortKey: CREATED_AT) {
        nodes { createdAt currentTotalPriceSet { shopMoney { amount } } }
      }
    }`);

    const q = data?.shopifyqlQuery;
    if (q?.parseErrors?.length) throw new Error(`ShopifyQL: ${q.parseErrors.join("; ")}`);
    const rows: any[] = q?.tableData?.rows ?? [];
    const todayIso = iso(c);

    for (const r of rows) {
      const net = num(r.net_sales), cogs = num(r.cost_of_goods_sold), ord = num(r.orders);
      base.mtdNet += net; base.mtdCogs += cogs; base.mtdOrders += ord;
      if (String(r.day).slice(0, 10) === todayIso) {
        base.netToday = round2(net);
        base.cogsToday = round2(cogs);
        base.ordersToday = ord;
        // returns come back negative; show the magnitude.
        base.returnsToday = round2(Math.abs(num(r.returns)));
      }
    }

    base.mtdNet = round2(base.mtdNet);
    base.mtdCogs = round2(base.mtdCogs);
    base.gpToday = round2(base.netToday - base.cogsToday);
    base.mtdGp = round2(base.mtdNet - base.mtdCogs);

    // Guarded: a store with no sales yet today would otherwise divide by zero
    // and render NaN%. Null means "nothing to show", which the UI can dash out.
    base.marginToday = base.netToday > 0
      ? round2((base.netToday - base.cogsToday) / base.netToday * 100) : null;
    base.aov = base.ordersToday > 0 ? round2(base.netToday / base.ordersToday) : null;
    base.mtdMargin = base.mtdNet > 0
      ? round2((base.mtdNet - base.mtdCogs) / base.mtdNet * 100) : null;

    const last = data?.orders?.nodes?.[0];
    if (last) {
      base.lastOrderAt = last.createdAt ?? null;
      base.lastOrderAmount = round2(num(last.currentTotalPriceSet?.shopMoney?.amount));
    }
  } catch (err) {
    // One store failing must not blank the other four. The row carries its own
    // error and the district totals simply exclude it.
    base.error = String(err).slice(0, 200);
  }

  return base;
}

// --- goals ------------------------------------------------------------------
// The monthly GP goal is a static number the DM already maintains, and it is
// already synced into app_cache/buy_sell_hub as <store>Goal. Read it rather than
// duplicating it: a second copy would drift the first time goals change.
async function loadGoals(sb: any): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const { data } = await sb.from("app_cache").select("payload").eq("key", "buy_sell_hub").single();
    const p = data?.payload ?? {};
    for (const code of STORE_ORDER) out[code] = Math.round(num(p[`${code.toLowerCase()}Goal`]));
  } catch (_) { /* goals absent -> tiles show a dash rather than a wrong number */ }
  return out;
}

// --- refresh ----------------------------------------------------------------

async function refresh(sb: any, now: Date, force: boolean) {
  const c = centralNow(now);
  const open = isOpen(c);

  const { data: cached } = await sb.from("app_cache").select("payload, synced_at")
    .eq("key", CACHE_KEY).maybeSingle();
  const prev = cached?.payload ?? null;
  const ageMs = cached?.synced_at ? now.getTime() - new Date(cached.synced_at).getTime() : Infinity;

  // The whole closed-hours cadence, in one condition: outside the window we only
  // work if the cache has gone stale.
  if (!force && !open && ageMs < CLOSED_STALE_MS) {
    return { ok: true, skipped: "closed and cache is fresh", open, ageSeconds: Math.round(ageMs / 1000) };
  }

  const { data: stores } = await sb.from("shopify_stores").select("shop, access_token");
  if (!stores?.length) return { ok: false, error: "no stores connected" };

  const goals = await loadGoals(sb);
  const sd = sellingDays(c);

  const metrics = await Promise.all(
    stores.map((s: any) => fetchStore(s.shop, s.access_token, c, goals[SHOP_TO_CODE[s.shop]] ?? 0)),
  );

  // Goal progress against SELLING-day progress, so "17% of goal" on day 5 reads
  // as slightly ahead rather than alarming. No forecast involved.
  const elapsedPct = sd.total > 0 ? sd.elapsed / sd.total * 100 : 0;
  for (const m of metrics) {
    if (m.goal > 0) {
      m.pctOfGoal = round2(m.mtdGp / m.goal * 100);
      m.paceIndex = elapsedPct > 0 ? Math.round(m.pctOfGoal / elapsedPct * 100) : null;
    }
  }

  const ordered = STORE_ORDER
    .map(code => metrics.find(m => m.code === code))
    .filter(Boolean) as StoreMetrics[];
  const healthy = ordered.filter(m => !m.error);

  const sum = (f: (m: StoreMetrics) => number) => round2(healthy.reduce((a, m) => a + f(m), 0));
  const dNet = sum(m => m.netToday), dCogs = sum(m => m.cogsToday);
  const dOrders = healthy.reduce((a, m) => a + m.ordersToday, 0);
  const dMtdNet = sum(m => m.mtdNet), dMtdCogs = sum(m => m.mtdCogs);
  const dGoal = healthy.reduce((a, m) => a + m.goal, 0);

  const district = {
    netToday: dNet,
    cogsToday: dCogs,
    gpToday: round2(dNet - dCogs),
    ordersToday: dOrders,
    returnsToday: sum(m => m.returnsToday),
    marginToday: dNet > 0 ? round2((dNet - dCogs) / dNet * 100) : null,
    aov: dOrders > 0 ? round2(dNet / dOrders) : null,
    mtdNet: dMtdNet,
    mtdGp: round2(dMtdNet - dMtdCogs),
    mtdMargin: dMtdNet > 0 ? round2((dMtdNet - dMtdCogs) / dMtdNet * 100) : null,
    goal: dGoal,
    pctOfGoal: dGoal > 0 ? round2((dMtdNet - dMtdCogs) / dGoal * 100) : null,
    storesReporting: healthy.length,
    storesTotal: ordered.length,
  };

  const payload = {
    asOfCentral: `${iso(c)} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`,
    open,
    month: { sellingDaysTotal: sd.total, sellingDaysElapsed: sd.elapsed, elapsedPct: round2(elapsedPct) },
    district,
    stores: ordered,
  };

  // Write and broadcast ONLY when a number moved. Nothing changes during a quiet
  // minute, so quiet minutes cost nothing — which is what keeps a per-minute
  // cron off the egress bill.
  const same = prev ? canon(stripVolatile(prev)) === canon(stripVolatile(payload)) : false;

  if (!same) {
    await sb.from("app_cache").upsert({ key: CACHE_KEY, payload, synced_at: new Date().toISOString() });
    // The payload rides along with the ping, so open dashboards update from the
    // broadcast itself instead of every client turning round and re-fetching.
    await broadcastChange("live", payload);
  }

  return {
    ok: true, open, changed: !same,
    storesReporting: district.storesReporting,
    errors: ordered.filter(m => m.error).map(m => ({ store: m.code, error: m.error })),
    asOfCentral: payload.asOfCentral,
  };
}

/** Fields that move every pass and must not count as a change. */
function stripVolatile(p: any) {
  const { asOfCentral, ...rest } = p ?? {};
  return rest;
}

/**
 * Key-order-independent serialization, for comparing the fresh payload against
 * the stored one.
 *
 * Postgres jsonb does NOT preserve key order — it stores keys sorted by length
 * then bytewise. So the payload that comes back out of app_cache stringifies
 * differently to the one that went in, even when every value is identical.
 * Comparing raw JSON.stringify therefore reported "changed" on every single
 * pass, which would have written the cache and broadcast to every open dashboard
 * once a minute forever — exactly the per-client traffic this design exists to
 * avoid. Sorting keys recursively is what makes the comparison mean anything.
 */
function canon(v: any): string {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
      return out;
    }
    // jsonb round-trips 8 and 8.0 identically, but a JS float that only differs
    // in trailing precision would otherwise read as a change.
    if (typeof x === "number") return Math.round(x * 100) / 100;
    return x;
  };
  return JSON.stringify(walk(v));
}

async function broadcastChange(tool: string, data?: unknown) {
  try {
    const base = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${base}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{
          topic: "speeks-notify",
          event: "changed",
          payload: { tool, store: null, ts: Date.now(), data },
        }],
      }),
    });
  } catch (_) { /* best-effort; the next pass will try again */ }
}

// --- read path (browser) ----------------------------------------------------

function scopeFor(role: string, store: string): { codes: string[]; district: boolean } {
  const r = role.toLowerCase().trim();
  const s = (store || "").toUpperCase().trim();
  if (DISTRICT_ROLES.includes(r) || s === "CORP") return { codes: STORE_ORDER, district: true };
  if (r === "multi-store manager") return { codes: MSM_STORES, district: false };
  return { codes: STORE_ORDER.includes(s) ? [s] : [], district: false };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const now = new Date();

  // ---- machine path: refresh from Shopify ----
  if (url.searchParams.get("secret") === SECRET) {
    return json(await refresh(sb, now, url.searchParams.get("force") === "1"));
  }

  // ---- browser path: read the cache, scoped ----
  const pin = req.headers.get("x-user-pin") || "";
  if (!pin) return json({ ok: false, error: "unauthorized" }, 401);

  const { data: user } = await sb.from("users").select("name, role, store").eq("pin", pin).single();
  // Stale sessionStorage pins survive a PIN change and produce exactly this —
  // say so, rather than leaving someone staring at an empty panel.
  if (!user) return json({ ok: false, error: "Invalid PIN — sign out and back in" }, 401);

  const { data: cached } = await sb.from("app_cache").select("payload, synced_at")
    .eq("key", CACHE_KEY).maybeSingle();
  if (!cached?.payload) {
    return json({ ok: true, pending: true, message: "No live data yet — the first refresh has not run." });
  }

  const p = cached.payload as any;
  const scope = scopeFor(String(user.role || ""), String(user.store || ""));
  const stores = (p.stores ?? []).filter((s: any) => scope.codes.includes(s.code));

  return json({
    ok: true,
    asOfCentral: p.asOfCentral,
    syncedAt: cached.synced_at,
    open: p.open,
    month: p.month,
    // The district roll-up is withheld from store staff on the server. A store
    // employee gets their store and nothing else, whatever the frontend renders.
    district: scope.district ? p.district : null,
    stores,
    scope: { role: user.role, store: user.store, district: scope.district },
  });
});
