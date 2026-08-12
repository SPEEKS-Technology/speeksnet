import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-pin",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Day-by-day buying and selling for one month, for the Daily Breakdown popout.
//
// TWO SOURCES, one shape. The month the stores are trading in comes from
// app_cache/buy_sell_hub — the same 10-minute cache the Live Dashboard and the
// Buying & Selling widget read, so the popout can never show a different figure
// from the card that opened it. Finished months come from daily_buysell, the
// hourly capture of that same cache (capture_daily_buysell), which is the only
// place a day survives the sheet rolling over.
//
// NAMING. The sheet's two money columns read backwards from what they are
// called everywhere in this codebase, and getting them the wrong way round is a
// silent 2x error:
//   sheet "Sell" column = resale value of what was bought -> `resale`
//                                        (hub wkBuy / daily_buysell.buy)
//   sheet "Buy" column  = cash actually paid out          -> `paid`
//                                        (resale * (1 - buyMargin))
// Verified against the live sheet for OVL August 2026: resale sums to 50,550.00
// and paid to 24,051.60, which are that store's Sell and Buy totals to the cent.
// The API deliberately says `resale`/`paid` rather than buy/sell so no caller
// has to remember which convention it is holding.

const STORES = ["OVL", "LEE", "WSP", "MPL", "BAL"];

// The picker never offers a month it cannot fill. June 2026 exists in
// daily_buysell as a single backfilled day (the 30th, reconstructed when the
// cross-month retention gap was closed) and would render as a month where every
// store did nothing for 29 days — worse than not offering June at all.
const MIN_DAYS_FOR_A_MONTH = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// The edge runtime is UTC, so a bare new Date() names the wrong month for the
// first six hours of the 1st — Central is still in the old month while UTC has
// already turned over, and the popout would open on an empty August while the
// stores were still finishing July. en-CA formats as YYYY-MM-DD.
function centralToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type Day = {
  day: number;
  sales: number | null;
  cost: number | null;
  gp: number | null;
  resale: number | null;
  paid: number | null;
  buyMargin: number | null;
};

// A day is only a row if the sheet actually carries something for it. Null, not
// zero: a day nobody has keyed yet and a day the store genuinely bought nothing
// are different facts, and rendering the first as $0 turns "not entered" into a
// reported zero. The frontend dashes nulls.
function makeDay(
  day: number,
  sales: unknown,
  gp: unknown,
  resale: unknown,
  margin: unknown,
): Day {
  const s = num(sales), g = num(gp), r = num(resale);
  const sold = s !== 0 || g !== 0;
  const bought = r !== 0;
  return {
    day,
    sales: sold ? s : null,
    cost: sold ? s - g : null,
    gp: sold ? g : null,
    resale: bought ? r : null,
    // Cash paid is derived per DAY and summed by the caller, never taken off a
    // mean of the margins: margins cannot be averaged across days of different
    // size. Same rule the Live Dashboard's _lvBuyFor follows.
    paid: bought ? r * (1 - num(margin)) : null,
    buyMargin: bought ? num(margin) : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const url = new URL(req.url);
    const today = centralToday();
    const thisMonth = today.slice(0, 7);

    const asked = String(url.searchParams.get("month") || "").trim();
    const month = /^\d{4}-\d{2}$/.test(asked) ? asked : thisMonth;
    const isCurrent = month === thisMonth;

    const [y, m] = month.split("-").map(Number);
    // Day 0 of the NEXT month is the last day of this one. UTC throughout: this
    // is arithmetic on a calendar, not a moment in time, so no zone applies.
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

    // Which months the picker may offer. Built from the history table rather
    // than from a hardcoded start date, so it grows by itself and can never
    // offer a month that turns out to be empty.
    const { data: histRows, error: histErr } = await supabase
      .from("daily_buysell")
      .select("date")
      .order("date", { ascending: false });
    if (histErr) throw histErr;

    const dayCount = new Map<string, Set<string>>();
    for (const r of histRows || []) {
      const ym = String(r.date).slice(0, 7);
      if (!dayCount.has(ym)) dayCount.set(ym, new Set());
      dayCount.get(ym)!.add(String(r.date));
    }
    const months = [...dayCount.entries()]
      .filter(([, days]) => days.size >= MIN_DAYS_FOR_A_MONTH)
      .map(([ym]) => ym);
    // The current month is always offered even before the hourly capture has
    // put five days in the history table — on the 2nd it is served from the
    // cache, which does not depend on that table at all.
    if (!months.includes(thisMonth)) months.push(thisMonth);
    months.sort().reverse();

    const stores: Record<string, { goal: number | null; days: Day[] }> = {};
    let source = "history";

    if (isCurrent) {
      // ---- the month in progress: straight off the shared cache ----
      const { data: cache, error: cacheErr } = await supabase
        .from("app_cache")
        .select("payload, synced_at")
        .eq("key", "buy_sell_hub")
        .maybeSingle();
      if (cacheErr) throw cacheErr;

      const p = (cache?.payload || {}) as Record<string, unknown>;
      const arr = (key: string, code: string): unknown[] => {
        const byStore = p[key] as Record<string, unknown> | undefined;
        const a = byStore && byStore[code];
        return Array.isArray(a) ? a : [];
      };
      source = "cache";

      for (const code of STORES) {
        const sell = arr("wkSell", code);
        const gp = arr("wkGP", code);
        const resale = arr("wkBuy", code);
        const margin = arr("wkBuyMarginPct", code);
        const days: Day[] = [];
        for (let d = 1; d <= daysInMonth; d++) {
          days.push(makeDay(d, sell[d - 1], gp[d - 1], resale[d - 1], margin[d - 1]));
        }
        const goalKey = code.toLowerCase() + "Goal";
        stores[code] = {
          // The GP goal is only known for the month the sheet is currently on.
          // Nothing stores a historical goal, so a finished month shows what it
          // did without claiming what it was asked to do.
          goal: p[goalKey] == null ? null : num(p[goalKey]),
          days,
        };
      }
    } else {
      // ---- a finished month: the hourly capture ----
      const last = month + "-" + String(daysInMonth).padStart(2, "0");
      const { data: rows, error } = await supabase
        .from("daily_buysell")
        .select("date, store, buy, sell, gp, buy_margin_pct")
        .gte("date", month + "-01")
        .lte("date", last);
      if (error) throw error;

      const byStore = new Map<string, Map<number, Record<string, unknown>>>();
      for (const r of rows || []) {
        const code = String(r.store || "").toUpperCase();
        if (!byStore.has(code)) byStore.set(code, new Map());
        byStore.get(code)!.set(Number(String(r.date).slice(8, 10)), r);
      }
      for (const code of STORES) {
        const mine = byStore.get(code) || new Map();
        const days: Day[] = [];
        for (let d = 1; d <= daysInMonth; d++) {
          const r = mine.get(d);
          days.push(makeDay(d, r?.sell, r?.gp, r?.buy, r?.buy_margin_pct));
        }
        stores[code] = { goal: null, days };
      }
    }

    return json({
      month,
      isCurrent,
      months,
      daysInMonth,
      source,
      // Which day the month has reached, so the table can stop at today rather
      // than printing a fortnight of empty rows for days that have not happened.
      today: isCurrent ? Number(today.slice(8, 10)) : null,
      stores,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
